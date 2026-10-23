package backend

import (
	"encoding/json"
	"fmt"
	"strings"
)

// nullableReferenceContract adapts the frozen TypeBox export for the OpenAPI
// reader, not the published contract. contract-generator.mjs represents a
// nullable reference as {"$ref":...,"nullable":true}. OpenAPI 3.0 readers may
// ignore that sibling. Express the same union explicitly without modifying the
// referenced schema (which must remain non-nullable in other positions).
func nullableReferenceContract(raw []byte) ([]byte, error) {
	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	// Type.Unknown exports an empty schema, which accepts every JSON value,
	// including null. The OpenAPI 3.0 reader otherwise rejects null at these
	// positions. Never apply this to an enclosing typed object or to examples.
	allowUnknownNull := func(value any) {
		if schema, ok := value.(map[string]any); ok && len(schema) == 0 {
			schema["nullable"] = true
		}
	}
	var visit func(any) error
	visit = func(value any) error {
		switch node := value.(type) {
		case map[string]any:
			if ref, ok := node["$ref"].(string); ok && node["nullable"] == true {
				if !strings.HasPrefix(ref, "#/components/schemas/") {
					return fmt.Errorf("unsupported nullable reference: %s", ref)
				}
				if _, exists := node["anyOf"]; exists {
					return fmt.Errorf("ambiguous nullable reference: %s", ref)
				}
				delete(node, "$ref")
				delete(node, "nullable")
				node["anyOf"] = []any{
					map[string]any{"$ref": ref},
					// This branch accepts only null, never an empty or malformed
					// object. The original ref still validates all non-null data.
					map[string]any{"type": "object", "nullable": true, "enum": []any{nil}},
				}
			}
			for key, child := range node {
				// Literal user examples/defaults are data, not schema references.
				if key == "example" || key == "examples" || key == "default" || key == "enum" || key == "const" {
					continue
				}
				switch key {
				case "additionalProperties", "items", "schema":
					allowUnknownNull(child)
				case "properties", "schemas", "patternProperties":
					if entries, ok := child.(map[string]any); ok {
						for _, schema := range entries {
							allowUnknownNull(schema)
						}
					}
				}
				if err := visit(child); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range node {
				if err := visit(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := visit(document); err != nil {
		return nil, err
	}
	return json.Marshal(document)
}
