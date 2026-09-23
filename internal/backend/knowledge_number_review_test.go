package backend

import "testing"

func TestReferenceNumberWhitespaceAndGrammar(t *testing.T) {
	for _, value := range []string{
		"\uFEFF2\uFEFF", "\u00A02\u00A0", "\u20282\u2029", "\u30002\u3000",
		"2.", ".2e1", "2.e0", "+2.0", "02", "0x02", "0o02", "0b010",
	} {
		n, ok := referenceQueryMonth(value)
		if !ok || n != 2 {
			t.Errorf("reference numeric input %q: got %d, valid=%t", value, n, ok)
		}
	}
	for _, value := range []string{"\uFEFF", "\u2028\u2029", "1e-9999", "-1e-9999"} {
		n, ok := referenceQueryMonth(value)
		if !ok || n != 0 {
			t.Errorf("reference zero input %q: got %d, valid=%t", value, n, ok)
		}
	}
	for _, value := range []string{
		"\u00852\u0085", "\u0085", "\u180E2", "\u200B2", "+0x1p1", "-0x0p0",
		"+0x2", "-0b0", "0x2p0", "2_0", "２", "0o8", "0b2", "0x", ".", "2e",
	} {
		if _, valid := referenceQueryMonth(value); valid {
			t.Errorf("non-JavaScript numeric input %q was accepted", value)
		}
	}
}
