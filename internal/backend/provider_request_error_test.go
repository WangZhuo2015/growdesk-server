package backend

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestNativeProviderTransportTimeoutBeforeContextTimer(t *testing.T) {
	for _, cause := range []error{context.DeadlineExceeded, os.ErrDeadlineExceeded} {
		t.Run(cause.Error(), func(t *testing.T) {
			ctx := context.Background() // The context timer has not fired.
			transport := &url.Error{Op: "Post", URL: "https://test.invalid/?credential=test_private", Err: cause}
			err := nativeProviderRequestError(ctx, transport)
			var failure *nativeProviderError
			if !errors.As(err, &failure) || failure.Code != "AI_PROVIDER_TIMEOUT" || !failure.Retryable {
				t.Fatalf("transport timeout lost its identity: %v", err)
			}
			if strings.Contains(err.Error(), "test_private") {
				t.Fatal("provider URL leaked through sanitized error")
			}
		})
	}
}

func TestNativeProviderContextDeadlineAndCancellation(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	err := nativeProviderRequestError(ctx, errors.New("test network failure"))
	var failure *nativeProviderError
	if !errors.As(err, &failure) || failure.Code != "AI_PROVIDER_TIMEOUT" {
		t.Fatalf("context deadline not retained: %v", err)
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	if err = nativeProviderRequestError(cancelled, os.ErrDeadlineExceeded); !errors.Is(err, context.Canceled) {
		t.Fatalf("explicit cancellation became retryable provider failure: %v", err)
	}
	wrapped := &url.Error{Op: "Post", URL: "https://test.invalid", Err: context.Canceled}
	if err = nativeProviderRequestError(context.Background(), wrapped); !errors.Is(err, context.Canceled) {
		t.Fatalf("wrapped cancellation not retained: %v", err)
	}
}

func TestNativeProviderOrdinaryNetworkErrorRemainsDistinct(t *testing.T) {
	err := nativeProviderRequestError(context.Background(), errors.New("test network failure"))
	var failure *nativeProviderError
	if !errors.As(err, &failure) || failure.Code != "AI_PROVIDER_NETWORK_ERROR" || !failure.Retryable {
		t.Fatalf("non-timeout network failure changed category: %v", err)
	}
}
