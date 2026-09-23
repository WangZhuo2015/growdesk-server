package backend

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
)

// scalarBodyHash reproduces JSON.stringify(request) for a validated flat DTO
// without sorting its properties. The raw bytes supply order only: values and
// removals come exclusively from the validated body. Repeated JSON properties
// keep their first insertion position and their final decoded value, like JS.
// This is intentionally not a serializer for arbitrary nested JSON documents.
func scalarBodyHash(r *Request) (string, error) {
	d := json.NewDecoder(bytes.NewReader(r.RawBody))
	d.UseNumber()
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return "", errors.New("missing original scalar request object")
	}
	seen := make(map[string]bool)
	pairs := make([]any, 0, len(r.Body)*2)
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return "", err
		}
		key, ok := token.(string)
		if !ok {
			return "", errors.New("invalid JSON object key")
		}
		var ignored json.RawMessage
		if err := d.Decode(&ignored); err != nil {
			return "", err
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		value, exists := r.Body[key]
		if !exists {
			continue
		}
		switch value.(type) {
		case nil, string, bool, json.Number, float64, int, int64:
		default:
			return "", errors.New("scalar receipt cannot hash a compound value")
		}
		pairs = append(pairs, key, value)
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return "", errors.New("invalid JSON object terminator")
	}
	if _, err = d.Token(); err != io.EOF {
		return "", errors.New("unexpected trailing JSON")
	}
	// None of the flat DTOs using this helper has schema-inserted defaults.
	// A future default needs its reference insertion order, not a guessed sort.
	if len(pairs)/2 != len(r.Body) {
		return "", errors.New("validated scalar keys differ from source keys")
	}
	return orderedHash(pairs...)
}

// fixedJSDecimal mirrors Number(decimal).toFixed(precision), including binary
// floating-point rounding and ties away from zero. fmt's fixed formatting uses
// ties-to-even and is observably different for values such as 8.125 at 2 places.
// Limits here match the bounded growth DTO, not a general decimal calculator.
func fixedJSDecimal(value any, precision int) (any, error) {
	if value == nil {
		return nil, nil
	}
	if precision < 0 || precision > 6 {
		return nil, errors.New("invalid fixed-decimal precision")
	}
	f, err := strconv.ParseFloat(text(value), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) >= 1e21 {
		return nil, errors.New("invalid persisted growth decimal")
	}
	negative := f < 0
	rational := new(big.Rat).SetFloat64(math.Abs(f))
	scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(precision)), nil)
	rational.Mul(rational, new(big.Rat).SetInt(scale))
	whole, remainder := new(big.Int), new(big.Int)
	whole.QuoRem(rational.Num(), rational.Denom(), remainder)
	if new(big.Int).Lsh(remainder, 1).Cmp(rational.Denom()) >= 0 {
		whole.Add(whole, big.NewInt(1))
	}
	result := whole.String()
	if precision > 0 {
		if len(result) <= precision {
			result = strings.Repeat("0", precision+1-len(result)) + result
		}
		result = result[:len(result)-precision] + "." + result[len(result)-precision:]
	}
	if negative {
		result = "-" + result
	}
	return result, nil
}
