package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	assets "github.com/WangZhuo2015/growdesk-server"
	"github.com/getkin/kin-openapi/openapi3"
)

type Route struct {
	Method, Path, OperationID string
	Operation                 *openapi3.Operation
	Segments                  []string
}
type Contract struct {
	Document *openapi3.T
	Routes   []*Route
	ByID     map[string]*Route
}

func LoadContract() (*Contract, error) {
	raw, err := assets.Assets.ReadFile("contracts/openapi.json")
	if err != nil {
		return nil, err
	}
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	doc, err := loader.LoadFromData(raw)
	if err != nil {
		return nil, fmt.Errorf("load pinned contract: %w", err)
	}
	c := &Contract{Document: doc, ByID: map[string]*Route{}}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			if op == nil {
				continue
			}
			if op.OperationID == "" || c.ByID[op.OperationID] != nil {
				return nil, errors.New("missing or duplicate operationId")
			}
			r := &Route{method, path, op.OperationID, op, strings.Split(strings.Trim(path, "/"), "/")}
			c.Routes = append(c.Routes, r)
			c.ByID[r.OperationID] = r
		}
	}
	// Literal segments precede parameters, mirroring the reference router.
	sort.Slice(c.Routes, func(i, j int) bool {
		a, b := c.Routes[i], c.Routes[j]
		for k := 0; k < len(a.Segments) && k < len(b.Segments); k++ {
			ap, bp := strings.HasPrefix(a.Segments[k], "{"), strings.HasPrefix(b.Segments[k], "{")
			if ap != bp {
				return !ap
			}
			if a.Segments[k] != b.Segments[k] {
				return a.Segments[k] < b.Segments[k]
			}
		}
		if len(a.Segments) != len(b.Segments) {
			return len(a.Segments) > len(b.Segments)
		}
		return a.Method < b.Method
	})
	return c, nil
}

func (c *Contract) Match(method, path string) (*Route, map[string]string) {
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for _, r := range c.Routes {
		if r.Method != method && !(method == http.MethodHead && r.Method == http.MethodGet) {
			continue
		}
		if len(parts) != len(r.Segments) {
			continue
		}
		params := map[string]string{}
		match := true
		for i, segment := range r.Segments {
			if strings.HasPrefix(segment, "{") {
				if parts[i] == "" {
					match = false
					break
				}
				params[strings.TrimSuffix(strings.TrimPrefix(segment, "{"), "}")] = parts[i]
			} else if segment != parts[i] {
				match = false
				break
			}
		}
		if match {
			return r, params
		}
	}
	return nil, nil
}

func schemaJSONValue(v any) any {
	// Schema validation sees numeric values without changing the original JSONB
	// payload, which preserves json.Number text for storage and request hashing.
	switch value := v.(type) {
	case json.Number:
		f, err := value.Float64()
		if err != nil {
			return v
		}
		return f
	case Object:
		r := map[string]any{}
		for k, x := range value {
			r[k] = schemaJSONValue(x)
		}
		return r
	case map[string]any:
		r := map[string]any{}
		for k, x := range value {
			r[k] = schemaJSONValue(x)
		}
		return r
	case []any:
		r := make([]any, len(value))
		for i, x := range value {
			r[i] = schemaJSONValue(x)
		}
		return r
	}
	return v
}

func (r *Route) Validate(req *http.Request, params map[string]string, body Object) error {
	query := req.URL.Query()
	allowedQuery := map[string]bool{}
	for _, p := range r.Operation.Parameters {
		if p != nil && p.Value != nil && p.Value.In == "query" {
			allowedQuery[p.Value.Name] = true
		}
	}
	if len(allowedQuery) > 0 {
		for key := range query {
			if !allowedQuery[key] {
				query.Del(key)
			}
		}
	}
	for _, p := range r.Operation.Parameters {
		if p == nil || p.Value == nil || p.Value.In != "query" || p.Value.Schema == nil {
			continue
		}
		sc := p.Value.Schema.Value
		if sc != nil && sc.Type.Is("integer") {
			if raw := query.Get(p.Value.Name); raw != "" {
				if n, e := strconv.ParseFloat(raw, 64); e == nil && !math.IsInf(n, 0) && math.Trunc(n) == n && n < math.Exp2(63) && n >= -math.Exp2(63) {
					query.Set(p.Value.Name, strconv.FormatInt(int64(n), 10))
				}
			}
		}
	}
	copyURL := *req.URL
	copyURL.RawQuery = query.Encode()
	req.URL = &copyURL
	for _, pr := range r.Operation.Parameters {
		if pr == nil || pr.Value == nil || pr.Value.Schema == nil {
			continue
		}
		p := pr.Value
		s := p.Schema.Value
		if s == nil {
			continue
		}
		var raw string
		var exists bool
		switch p.In {
		case "path":
			raw, exists = params[p.Name]
		case "query":
			values, ok := req.URL.Query()[p.Name]
			exists = ok
			if len(values) > 0 {
				raw = values[0]
			}
		case "header":
			raw = req.Header.Get(p.Name)
			exists = raw != ""
		default:
			continue
		}
		if !exists {
			if p.Required {
				return apiError(400, "FST_ERR_VALIDATION", p.In+"/"+p.Name+" is required")
			}
			continue
		}
		var value any = raw
		if s.Type != nil && s.Type.Is("integer") {
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil {
				return apiError(400, "FST_ERR_VALIDATION", p.Name+" must be an integer")
			}
			value = float64(n)
		}
		if s.Type != nil && s.Type.Is("boolean") {
			if raw == "true" {
				value = true
			} else if raw == "false" {
				value = false
			} else {
				return apiError(400, "FST_ERR_VALIDATION", p.Name+" must be boolean")
			}
		}
		if err := s.VisitJSON(value, wireFormats...); err != nil {
			return apiError(400, "FST_ERR_VALIDATION", "Invalid "+p.In+" parameter "+p.Name)
		}
	}
	if ref := r.Operation.RequestBody; ref != nil && ref.Value != nil {
		rb := ref.Value
		media := rb.Content.Get("application/json")
		if media != nil && media.Schema != nil && media.Schema.Value != nil {
			if body == nil && rb.Required {
				return apiError(400, "FST_ERR_VALIDATION", "Request body is required")
			}
			if body != nil {
				if err := normalizeBody(media.Schema.Value, body); err != nil {
					return err
				}
				if err := media.Schema.Value.VisitJSON(schemaJSONValue(body), wireFormats...); err != nil {
					return apiError(400, "FST_ERR_VALIDATION", "Request body does not match the API contract")
				}
			}
		}
	}
	return nil
}

func (r *Route) ValidateResponse(ctx context.Context, status int, value any) error {
	_ = ctx
	ref := r.Operation.Responses.Status(status)
	if ref == nil || ref.Value == nil {
		return fmt.Errorf("%s: undeclared HTTP status %d", r.OperationID, status)
	}
	media := ref.Value.Content.Get("application/json")
	if media == nil || media.Schema == nil || media.Schema.Value == nil {
		return nil
	}
	return media.Schema.Value.VisitJSON(schemaJSONValue(value), wireFormats...)
}
