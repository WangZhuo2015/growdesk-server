package backend

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type nativeObjectStore struct {
	Client    *s3.Client
	Presigner *s3.PresignClient
	Bucket    string
	HTTP      *http.Client
}

var storageBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
var attachmentIO = make(chan struct{}, 4)

func newNativeObjectStore(c Config) (*nativeObjectStore, error) {
	bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	endpoint := strings.TrimSpace(os.Getenv("S3_ENDPOINT"))
	if bucket == "" && endpoint == "" {
		return nil, nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || !storageBucketPattern.MatchString(bucket) {
		return nil, errors.New("invalid object storage configuration")
	}
	access, secret, token := os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"), os.Getenv("AWS_SESSION_TOKEN")
	if access == "" || len(secret) < 8 {
		return nil, errors.New("explicit object storage credentials are required")
	}
	// Never discover instance credentials, select a public bucket as fallback,
	// disable TLS verification, or relax the isolated-preview boundary.
	if c.Environment == "test" || c.Environment == "development" {
		port, e := strconv.Atoi(u.Port())
		if u.Hostname() != "127.0.0.1" || e != nil || port < 1 || port > 65535 || port == 80 || port == 443 || !strings.HasPrefix(bucket, "test-") || !(strings.HasPrefix(access, "test_") || strings.HasPrefix(access, "e2e_")) {
			return nil, errors.New("native preview requires owned loopback test object storage")
		}
	}
	region := os.Getenv("S3_REGION")
	if region == "" { region = "us-east-1" }
	httpClient := providerHTTPClient(20 * time.Second)
	credentials := aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: access, SecretAccessKey: secret, SessionToken: token, Source: "GrowDeskExplicit"}, nil
	})
	client := s3.New(s3.Options{
		Region: region, Credentials: credentials, BaseEndpoint: aws.String(strings.TrimRight(endpoint, "/")),
		UsePathStyle: true, HTTPClient: httpClient, RetryMaxAttempts: 2,
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	return &nativeObjectStore{Client: client, Presigner: s3.NewPresignClient(client), Bucket: bucket, HTTP: httpClient}, nil
}

func (s *nativeObjectStore) Close() {
	if s != nil && s.HTTP != nil { s.HTTP.CloseIdleConnections() }
}
func requireObjectStore(s *Server) (*nativeObjectStore, error) {
	if s.ObjectStore == nil {
		return nil, apiError(503, "STORAGE_NOT_CONFIGURED", "Private object storage is not configured")
	}
	return s.ObjectStore, nil
}
func validStorageKey(key string) bool {
	if key == "" || len(key) > 500 || strings.HasPrefix(key, "/") || strings.ContainsAny(key, "\\\x00\r\n") { return false }
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." { return false }
	}
	return true
}
func storageFailure() error {
	return apiError(503, "STORAGE_UNAVAILABLE", "Private object storage could not complete the operation")
}

func (s *nativeObjectStore) uploadURL(ctx context.Context, key, mime string, size int64, ttl time.Duration) (string, error) {
	if !validStorageKey(key) || size < 1 || size > 25*1024*1024 || ttl <= 0 || ttl > time.Hour {
		return "", invalid("Invalid upload capability")
	}
	value, err := s.Presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.Bucket), Key: aws.String(key), ContentType: aws.String(mime), ContentLength: aws.Int64(size),
	}, func(o *s3.PresignOptions) { o.Expires = ttl })
	if err != nil { return "", storageFailure() }
	return value.URL, nil
}
func (s *nativeObjectStore) remove(ctx context.Context, key string) error {
	if !validStorageKey(key) { return invalid("Invalid stored object identifier") }
	_, err := s.Client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(key)})
	if err != nil { return storageFailure() }
	return nil
}

// Request-owned mode-0600 files are bounded verification buffers, not business
// persistence. Capture the allocation itself: an error return may set a named
// return pointer to nil before deferred cleanup executes.
func (s *nativeObjectStore) verifiedFile(ctx context.Context, key string, size int64, wantHash string) (file *os.File, err error) {
	if !validStorageKey(key) || size < 1 || size > 25*1024*1024 { return nil, invalid("Invalid attachment metadata") }
	response, err := s.Client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.Bucket), Key: aws.String(key)})
	if err != nil { return nil, storageFailure() }
	defer response.Body.Close()
	if response.ContentLength != nil && *response.ContentLength != size {
		return nil, apiError(400, "BAD_REQUEST", "Attachment size does not match its metadata")
	}
	temporary, err := os.CreateTemp("", "growdesk-attachment-*")
	if err != nil { return nil, apiError(503, "STORAGE_BUFFER_UNAVAILABLE", "Attachment verification buffer is unavailable") }
	defer func() {
		if err != nil {
			_ = temporary.Close()
			_ = os.Remove(temporary.Name())
		}
	}()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(response.Body, size+1))
	if err != nil { return nil, storageFailure() }
	if written != size || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), wantHash) {
		return nil, apiError(400, "BAD_REQUEST", "Attachment bytes failed integrity verification")
	}
	if _, err = temporary.Seek(0, io.SeekStart); err != nil { return nil, err }
	return temporary, nil
}

func (s *nativeObjectStore) seal(ctx context.Context, key, mime string, size int64, hash string, file *os.File) error {
	if !validStorageKey(key) { return invalid("Invalid sealed object identifier") }
	digest, err := hex.DecodeString(hash)
	if err != nil || len(digest) != sha256.Size { return invalid("Invalid attachment digest") }
	if _, err = file.Seek(0, io.SeekStart); err != nil { return err }
	_, err = s.Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.Bucket), Key: aws.String(key), Body: file, ContentType: aws.String(mime),
		ContentLength: aws.Int64(size), ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(digest)),
	})
	if err != nil { return storageFailure() }
	return nil
}

func acquireAttachmentIO() (func(), error) {
	select {
	case attachmentIO <- struct{}{}:
		return func() { <-attachmentIO }, nil
	default:
		return nil, apiError(503, "STORAGE_BUSY", "Attachment concurrency limit reached")
	}
}
