package backend

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"sync"

	assets "github.com/WangZhuo2015/growdesk-server"
)

type referenceCatalogs struct {
	Milestones   []Object `json:"milestones"`
	WarningSigns []Object `json:"warningSigns"`
	Activities   []Object `json:"activities"`
	Guidelines   []Object `json:"guidelines"`
	DataRelease  Object   `json:"dataRelease"`
	Books        []Object `json:"-"`
	BooksByID    map[string]Object `json:"-"`
}

// The embedded inputs are immutable public data snapshots containing one JSON
// literal. Never execute TypeScript, read a user path, fetch a remote source or
// substitute an empty catalog when the snapshot is malformed.
func decodeReferenceLiteral(source []byte, name string, target any) error {
	marker := []byte("export const " + name + ":")
	if bytes.Count(source, marker) != 1 {
		return errors.New("reference snapshot must have exactly one named export")
	}
	declaration := source[bytes.Index(source, marker)+len(marker):]
	_, literal, found := bytes.Cut(declaration, []byte(" = "))
	if !found {
		return errors.New("reference snapshot initializer is missing")
	}
	literal = bytes.TrimSpace(literal)
	if !bytes.HasSuffix(literal, []byte(";")) {
		return errors.New("reference snapshot terminator is missing")
	}
	return decodeJSON(bytes.TrimSuffix(literal, []byte(";")), target)
}

var loadReferenceCatalogs = sync.OnceValues(func() (*referenceCatalogs, error) {
	data, err := assets.KnowledgeAssets.ReadFile("apps/api/src/knowledge/legacy-reference-data.ts")
	if err != nil {
		return nil, err
	}
	var catalog referenceCatalogs
	if err := decodeReferenceLiteral(data, "referenceData", &catalog); err != nil {
		return nil, fmt.Errorf("invalid embedded development catalog: %w", err)
	}
	data, err = assets.KnowledgeAssets.ReadFile("apps/api/src/knowledge/books-data.ts")
	if err != nil {
		return nil, err
	}
	if err := decodeReferenceLiteral(data, "books", &catalog.Books); err != nil {
		return nil, fmt.Errorf("invalid embedded book catalog: %w", err)
	}
	if len(catalog.Milestones) == 0 || len(catalog.WarningSigns) == 0 || len(catalog.Activities) == 0 || len(catalog.Books) == 0 || catalog.DataRelease == nil {
		return nil, errors.New("embedded reference catalog is incomplete")
	}
	catalog.BooksByID = make(map[string]Object, len(catalog.Books))
	for _, book := range catalog.Books {
		id := text(book["id"])
		if id == "" || text(book["title"]) == "" || catalog.BooksByID[id] != nil {
			return nil, errors.New("embedded book identity is invalid or duplicated")
		}
		catalog.BooksByID[id] = book
	}
	return &catalog, nil
})

func cloneJSON(value Object) (Object, error) {
	raw, err := jsonBytes(value)
	if err != nil {
		return nil, err
	}
	var result Object
	if err := decodeJSON(raw, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func referenceNumeric(value any) float64 {
	if value == nil {
		return 0
	}
	n, err := strconv.ParseFloat(text(value), 64)
	if err != nil {
		return math.NaN()
	}
	return n
}

func developmentProjection(kind string, item Object) (Object, error) {
	var fields []string
	switch kind {
	case "milestones":
		fields = []string{"id", "monthAge", "category", "title", "description"}
	case "activities":
		fields = []string{"id", "monthAge", "title", "content"}
	case "warningSigns":
		fields = []string{"id", "monthAge", "signText", "actionAdvice"}
	default:
		return nil, errors.New("unknown internal development catalog")
	}
	// Fastify's response serializer drops additional properties at the root;
	// the full public reference entry is intentionally retained inside details.
	details, err := cloneJSON(item)
	if err != nil {
		return nil, err
	}
	value := Object{"details": details}
	for _, field := range fields {
		v, exists := item[field]
		if !exists {
			return nil, errors.New("embedded development entry is missing a required field")
		}
		value[field] = v
	}
	return value, nil
}

func (s *Server) registerKnowledge() {
	s.Register("getAppConfig", true, func(_ context.Context, _ *Request) (Result, error) {
		return ok(Object{"timeZone": "Asia/Shanghai", "features": Object{"swDisabled": os.Getenv("SW_DISABLED") == "1", "cloud": true},
			"serverVersion": "0.1.0", "minClientVersion": "0.1.0"})
	})
	for _, spec := range []struct{ operation, kind string }{
		{"listMilestones", "milestones"}, {"listActivities", "activities"}, {"listWarningSigns", "warningSigns"},
	} {
		kind := spec.kind
		s.Register(spec.operation, false, func(_ context.Context, r *Request) (Result, error) {
			catalog, err := loadReferenceCatalogs()
			if err != nil {
				return Result{}, err
			}
			source := catalog.Milestones
			if kind == "activities" {
				source = catalog.Activities
			} else if kind == "warningSigns" {
				source = catalog.WarningSigns
			}
			query := r.HTTP.URL.Query()
			month, filteredByMonth := 0, query.Has("month")
			if filteredByMonth {
				month, err = strconv.Atoi(query.Get("month"))
				if err != nil || month < 0 || month > 216 {
					return Result{}, invalid("Invalid month")
				}
			}
			values := make([]Object, 0)
			for _, item := range source {
				if category := query.Get("category"); category != "" && text(item["category"]) != category {
					continue
				}
				if filteredByMonth {
					if kind == "activities" {
						if item["ageMinMonths"] != nil && !(referenceNumeric(item["ageMinMonths"]) <= float64(month)) {
							continue
						}
						if item["ageMaxMonths"] != nil && !(referenceNumeric(item["ageMaxMonths"]) >= float64(month)) {
							continue
						}
					} else if referenceNumeric(item["monthAge"]) != float64(month) {
						continue
					}
				}
				value, err := developmentProjection(kind, item)
				if err != nil {
					return Result{}, err
				}
				values = append(values, value)
			}
			body := Object{"data": values}
			if kind == "milestones" {
				release, err := cloneJSON(catalog.DataRelease)
				if err != nil {
					return Result{}, err
				}
				body["dataRelease"] = release
			}
			return Result{Status: 200, Body: body}, nil
		})
	}
}
