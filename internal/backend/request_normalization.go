package backend

import (
	"fmt"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
)

var wireFormats = []openapi3.SchemaValidationOption{
	openapi3.EnableFormatValidation(),
	openapi3.WithStringFormatValidator("uuid", openapi3.NewRegexpFormatValidator(`(?i)^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)),
	openapi3.WithStringFormatValidator("date", openapi3.NewCallbackValidator(func(value string) error {
		_, err := time.Parse("2006-01-02", value)
		return err
	})),
	openapi3.WithStringFormatValidator("date-time", openapi3.NewCallbackValidator(func(value string) error {
		if len(value) < 20 {
			return fmt.Errorf("invalid date-time")
		}
		_, err := asTime(value)
		return err
	})),
}

// Match the reference Ajv removeAdditional/useDefaults behavior for explicit
// object schemas. Do not coerce JSON body scalar types. Unions are left intact
// for schema validation rather than guessing a variant and losing input data.
func normalizeBody(schema *openapi3.Schema, value any) error {
	if schema == nil {
		return nil
	}
	object := obj(value)
	if object != nil && (schema.Type.Is("object") || len(schema.Properties) > 0) {
		if schema.AdditionalProperties.Has != nil && !*schema.AdditionalProperties.Has {
			for key := range object {
				if _, known := schema.Properties[key]; !known {
					delete(object, key)
				}
			}
		}
		for key, ref := range schema.Properties {
			if ref == nil || ref.Value == nil {
				continue
			}
			item, exists := object[key]
			if !exists && ref.Value.Default != nil {
				// Defaults are shared schema values; never expose mutable ones.
				raw, err := jsonBytes(ref.Value.Default)
				if err != nil {
					return err
				}
				if err = decodeJSON(raw, &item); err != nil {
					return err
				}
				object[key] = item
				exists = true
			}
			if exists {
				if err := normalizeBody(ref.Value, item); err != nil {
					return err
				}
			}
		}
	}
	if list, ok := value.([]any); ok && schema.Items != nil {
		for _, item := range list {
			if err := normalizeBody(schema.Items.Value, item); err != nil {
				return err
			}
		}
	}
	return nil
}
