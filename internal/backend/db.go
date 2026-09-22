package backend

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Object is confined to JSON contracts/JSONB. SQL names never come from Object keys
// without an explicit, statically declared field allowlist.
type Object map[string]any

type Querier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func openDatabase(ctx context.Context, c Config) (*pgxpool.Pool, error) {
	if err := ValidateDatabaseURL(c.DatabaseURL, c.Environment == "test"); err != nil {
		return nil, err
	}
	cfg, err := pgxpool.ParseConfig(c.DatabaseURL)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}
	cfg.MaxConns = c.MaxDBConnections
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	cfg.ConnConfig.RuntimeParams["application_name"] = "growdesk-go"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("database initialization failed")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("database unavailable")
	}
	if c.Environment == "test" {
		var name, user string
		var super bool
		err = pool.QueryRow(ctx, "SELECT current_database(), current_user, rolsuper FROM pg_roles WHERE rolname=current_user").Scan(&name, &user, &super)
		if err != nil || super || !testName.MatchString(name) || !testName.MatchString(user) {
			pool.Close()
			return nil, errors.New("test database identity check failed")
		}
	}
	return pool, nil
}

func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

func one(ctx context.Context, q Querier, sql string, args ...any) (Object, error) {
	var raw []byte
	if err := q.QueryRow(ctx, sql, args...).Scan(&raw); err != nil {
		return nil, err
	}
	var value Object
	err := decodeJSON(raw, &value)
	return value, err
}

func many(ctx context.Context, q Querier, sql string, args ...any) ([]Object, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Object, 0)
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var value Object
		if err := decodeJSON(raw, &value); err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func decodeJSON(raw []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("expected one JSON value")
	}
	return nil
}

func jsonBytes(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}
func jsonText(v any) (string, error) { b, e := jsonBytes(v); return string(b), e }
func hashText(s string) string       { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("system random source unavailable")
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("system random source unavailable")
	}
	return hex.EncodeToString(b)
}
func text(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		return ""
	}
}
func integer(v any) int64 {
	raw := text(v)
	n, err := strconv.ParseInt(raw, 10, 64)
	if err == nil {
		return n
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f || f >= math.Exp2(63) || f < -math.Exp2(63) {
		return 0
	}
	return int64(f)
}
func boolean(v any) bool { b, _ := v.(bool); return b }
func obj(v any) Object {
	if o, ok := v.(map[string]any); ok {
		return Object(o)
	}
	if o, ok := v.(Object); ok {
		return o
	}
	return nil
}
func nullableString(v any) any {
	if v == nil {
		return nil
	}
	return text(v)
}
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func asTime(v any) (time.Time, error) {
	if t, ok := v.(time.Time); ok {
		return t, nil
	}
	s := text(v)
	t, e := time.Parse(time.RFC3339Nano, s)
	if e == nil {
		return t, nil
	}
	return time.Parse("2006-01-02", s)
}
func isoValue(v any) any {
	if v == nil {
		return nil
	}
	t, err := asTime(v)
	if err != nil {
		return v
	}
	return iso(t)
}
func dateValue(v any) any {
	if v == nil {
		return nil
	}
	s := text(v)
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}
func decimalValue(v any) any {
	if v == nil {
		return nil
	}
	s := text(v)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if s == "-0" {
		s = "0"
	}
	return s
}
func copyObject(in Object) Object {
	out := Object{}
	for k, v := range in {
		out[k] = v
	}
	return out
}
func envelope(data any) Object { return Object{"data": data} }
func page(data any, cursor any) Object {
	return Object{"data": data, "page": Object{"nextCursor": cursor}}
}
func success() Object { return envelope(Object{"success": true}) }

// orderedHash preserves JSON.stringify property order used by the TypeScript
// receipt protocol. Absent optional fields must be omitted by the caller.
func orderedHash(pairs ...any) (string, error) {
	if len(pairs)%2 != 0 {
		return "", errors.New("invalid hash fields")
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i := 0; i < len(pairs); i += 2 {
		key, ok := pairs[i].(string)
		if !ok {
			return "", errors.New("invalid hash key")
		}
		kb, err := jsonBytes(key)
		if err != nil {
			return "", err
		}
		vb, err := receiptJSON(pairs[i+1])
		if err != nil {
			return "", err
		}
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(kb)
		b.WriteByte(':')
		b.Write(vb)
	}
	b.WriteByte('}')
	return hashText(b.String()), nil
}

// insertObject is an internal primitive. Every caller supplies a constant table
// and explicitly constructed database-column map; no request key is a SQL name.
func insertObject(ctx context.Context, q Querier, table string, values Object) (Object, error) {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	cols := make([]string, 0, len(keys))
	marks := make([]string, 0, len(keys))
	args := make([]any, 0, len(keys))
	for i, k := range keys {
		cols = append(cols, pgx.Identifier{k}.Sanitize())
		marks = append(marks, fmt.Sprintf("$%d", i+1))
		args = append(args, values[k])
	}
	return one(ctx, q, "INSERT INTO "+pgx.Identifier{table}.Sanitize()+" AS inserted ("+strings.Join(cols, ",")+") VALUES ("+strings.Join(marks, ",")+") RETURNING to_jsonb(inserted)", args...)
}

// JSON.stringify does not escape U+2028/U+2029. Go encoding/json does, even
// with SetEscapeHTML(false). Hash primitive string fields with JS-compatible
// quoting; a literal backslash-u sequence remains a literal backslash sequence.
func receiptJSON(value any) ([]byte, error) {
	text, ok := value.(string)
	if !ok {
		return jsonBytes(value)
	}
	var b bytes.Buffer
	b.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.Bytes(), nil
}
