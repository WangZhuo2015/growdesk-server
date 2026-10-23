package backend

import (
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The frozen OpenAPI omits query parameters actually validated by knowledge-
// routes.ts and book-routes.ts. Keep that reference drift explicit here rather
// than editing the frozen specification or allowing malformed input through.
// Like Fastify pre-handler validation, this runs before authentication.
func normalizeReferenceCatalogQuery(operation string, request *http.Request) error {
	allowed := map[string]bool{}
	switch operation {
	case "listMilestones", "listActivities", "listWarningSigns":
		allowed["month"], allowed["category"] = true, true
	case "listBooks":
		allowed["familyId"] = true
	default:
		return nil
	}
	query := request.URL.Query()
	for key := range query {
		if !allowed[key] {
			query.Del(key)
		}
	}
	failure := func(field string) error {
		return apiError(400, "FST_ERR_VALIDATION", "Invalid query parameter "+field)
	}
	if operation == "listBooks" {
		values := query["familyId"]
		if len(values) != 1 || values[0] == "" {
			return failure("familyId")
		}
	} else {
		if values, present := query["month"]; present {
			if len(values) != 1 {
				return failure("month")
			}
			n, valid := referenceQueryMonth(values[0])
			if !valid {
				return failure("month")
			}
			query.Set("month", strconv.Itoa(n))
		}
		if values, present := query["category"]; present {
			if len(values) != 1 || utf8.RuneCountInString(values[0]) > 80 {
				return failure("category")
			}
		}
	}
	url := *request.URL
	url.RawQuery = query.Encode()
	request.URL = &url
	return nil
}

var referenceDecimalMonth = regexp.MustCompile(`^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$`)

// ECMAScript WhiteSpace plus LineTerminator, not Go's broader TrimSpace.
// In particular U+FEFF is accepted, while U+0085 is not numeric whitespace.
func referenceNumberWhitespace(r rune) bool {
	switch r {
	case '\t', '\v', '\f', '\n', '\r', '\uFEFF', '\u2028', '\u2029':
		return true
	default:
		return unicode.Is(unicode.Zs, r)
	}
}

// Ajv integer coercion accepts nonempty numeric strings such as "2.0", "2e0"
// and unsigned JS Number radix prefixes. Unlike Go numeric syntax, underscores,
// signed nondecimal values and hex floating-point notation are not accepted.
// Empty text is not coercible; a nonempty string of JS whitespace becomes zero.
func referenceQueryMonth(raw string) (int, bool) {
	if raw == "" {
		return 0, false
	}
	value := strings.TrimFunc(raw, referenceNumberWhitespace)
	if strings.Contains(value, "_") {
		return 0, false
	}
	if value == "" {
		return 0, true
	}
	var number float64
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "0x") || strings.HasPrefix(lower, "0o") || strings.HasPrefix(lower, "0b") {
		base := 16
		if lower[1] == 'o' {
			base = 8
		} else if lower[1] == 'b' {
			base = 2
		}
		parsed, err := strconv.ParseUint(value[2:], base, 64)
		if err != nil {
			return 0, false
		}
		number = float64(parsed)
	} else {
		if !referenceDecimalMonth.MatchString(value) {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return 0, false
		}
		number = parsed
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < 0 || number > 216 {
		return 0, false
	}
	return int(number), true
}
