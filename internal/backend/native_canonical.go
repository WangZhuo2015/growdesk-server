package backend

import (
	"sort"
	"unicode/utf16"
)

func utf16Less(a, b string) bool {
	left, right := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] != right[i] {
			return left[i] < right[i]
		}
	}
	return len(left) < len(right)
}
func canonicalNativeHash(value any) (string, error) {
	value, err := toJSONValue(value)
	if err != nil {
		return "", err
	}
	var order func(any) *jsonOrder
	order = func(value any) *jsonOrder {
		result := &jsonOrder{}
		if object := obj(value); object != nil {
			result.keys = sortedKeys(object)
			sort.Slice(result.keys, func(i, j int) bool { return utf16Less(result.keys[i], result.keys[j]) })
			result.children = map[string]*jsonOrder{}
			for key, item := range object {
				result.children[key] = order(item)
			}
		} else if items, ok := value.([]any); ok {
			for _, item := range items {
				result.items = append(result.items, order(item))
			}
		}
		return result
	}
	raw, err := orderedDocumentJSON(value, order(value))
	if err != nil {
		return "", err
	}
	return hashText(string(raw)), nil
}
