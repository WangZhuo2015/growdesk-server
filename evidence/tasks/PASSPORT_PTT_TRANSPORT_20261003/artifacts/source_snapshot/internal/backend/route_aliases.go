package backend

import (
	"net/http"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
)

// Frozen route definitions omit legacy aliases still registered by Fastify.
// Match only explicit shapes; never synthesize a user/family/baby identity.
// Aliases reuse the same handler, authorization and input contract and do not
// inflate the declared-operation coverage inventory.
func (s *Server) matchNativeRoute(method, path string) (*Route, map[string]string) {
	if route, params := s.Contract.Match(method, path); route != nil { return route, params }
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if (len(parts) == 6 || len(parts) == 7) && parts[0] == "api" && parts[1] == "v1" && parts[2] == "babies" && parts[3] != "" && parts[4] == "medical" && parts[5] == "reports" {
		canonical := "/api/v1/babies/" + parts[3] + "/medical-reports"
		if len(parts) == 7 { canonical += "/" + parts[6] }
		return s.Contract.Match(method, canonical)
	}
	if path == "/api/v1/vaccines/schedule" && (method == http.MethodGet || method == http.MethodHead) {
		template := s.Contract.ByID["getVaccineSchedule"]
		if template == nil { return nil, nil }
		route := *template
		operation := *template.Operation
		operation.Parameters = make(openapi3.Parameters, 0, len(template.Operation.Parameters))
		for _, parameter := range template.Operation.Parameters {
			if parameter != nil && parameter.Value != nil && parameter.Value.In != "path" { operation.Parameters = append(operation.Parameters, parameter) }
		}
		route.Path, route.Operation = path, &operation
		return &route, map[string]string{}
	}
	return nil, nil
}
