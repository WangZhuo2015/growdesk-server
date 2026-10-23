package backend

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strconv"
)

// jsonOrder carries structure and insertion order, never authoritative values.
// The schema-validated body supplies every byte of the persisted request hash.
type jsonOrder struct {
	keys []string
	children map[string]*jsonOrder
	items []*jsonOrder
}

func readJSONOrder(d *json.Decoder, depth int) (*jsonOrder, error) {
	if depth > 64 { return nil, invalid("JSON nesting exceeds the receipt limit") }
	token, err := d.Token()
	if err != nil { return nil, err }
	order := &jsonOrder{}
	switch token {
	case json.Delim('{'):
		order.children = map[string]*jsonOrder{}
		for d.More() {
			keyToken, err := d.Token()
			if err != nil { return nil, err }
			key, ok := keyToken.(string)
			if !ok { return nil, errors.New("invalid receipt object key") }
			child, err := readJSONOrder(d, depth+1)
			if err != nil { return nil, err }
			if _, seen := order.children[key]; !seen { order.keys = append(order.keys, key) }
			order.children[key] = child
		}
		if end, err := d.Token(); err != nil || end != json.Delim('}') { return nil, errors.New("invalid receipt object") }
		// ECMAScript enumerates canonical uint32 property indexes first.
		sort.SliceStable(order.keys, func(i, j int) bool {
			a, ai := jsonPropertyIndex(order.keys[i]); b, bi := jsonPropertyIndex(order.keys[j])
			if ai && bi { return a < b }; return ai && !bi
		})
	case json.Delim('['):
		for d.More() {
			child, err := readJSONOrder(d, depth+1)
			if err != nil { return nil, err }
			order.items = append(order.items, child)
		}
		if end, err := d.Token(); err != nil || end != json.Delim(']') { return nil, errors.New("invalid receipt array") }
	case json.Delim('}'), json.Delim(']'):
		return nil, errors.New("invalid receipt delimiter")
	}
	return order, nil
}

func jsonPropertyIndex(key string) (uint64, bool) {
	n, err := strconv.ParseUint(key, 10, 32)
	return n, err == nil && n < math.MaxUint32 && strconv.FormatUint(n, 10) == key
}

func orderedDocumentJSON(value any, order *jsonOrder) ([]byte, error) {
	if object := obj(value); object != nil {
		if order == nil { return nil, errors.New("missing object key order") }
		var out bytes.Buffer
		out.WriteByte('{')
		count := 0
		for _, key := range order.keys {
			item, exists := object[key]
			if !exists { continue }
			encodedKey, err := receiptJSON(key)
			if err != nil { return nil, err }
			encodedValue, err := orderedDocumentJSON(item, order.children[key])
			if err != nil { return nil, err }
			if count > 0 { out.WriteByte(',') }
			out.Write(encodedKey); out.WriteByte(':'); out.Write(encodedValue)
			count++
		}
		if count != len(object) { return nil, errors.New("schema-added receipt fields need explicit ordering") }
		out.WriteByte('}')
		return out.Bytes(), nil
	}
	if list, ok := value.([]any); ok {
		if order == nil || len(order.items) != len(list) { return nil, errors.New("receipt array structure changed") }
		var out bytes.Buffer
		out.WriteByte('[')
		for i, item := range list {
			encoded, err := orderedDocumentJSON(item, order.items[i])
			if err != nil { return nil, err }
			if i > 0 { out.WriteByte(',') }; out.Write(encoded)
		}
		out.WriteByte(']')
		return out.Bytes(), nil
	}
	if number, ok := value.(json.Number); ok {
		n, err := number.Float64()
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) { return nil, invalid("Invalid receipt number") }
		if n == 0 { n = 0 }
		return jsonBytes(n)
	}
	return receiptJSON(value)
}

// Only routes whose reference hashes JSON.stringify(request) use this helper.
// Optional fields omitted by the caller stay omitted; JSON null stays present.
func documentBodyHash(r *Request) (string, error) {
	d := json.NewDecoder(bytes.NewReader(r.RawBody))
	d.UseNumber()
	order, err := readJSONOrder(d, 0)
	if err != nil { return "", err }
	if _, err = d.Token(); err != io.EOF { return "", errors.New("trailing receipt document") }
	raw, err := orderedDocumentJSON(r.Body, order)
	if err != nil { return "", err }
	return hashText(string(raw)), nil
}
