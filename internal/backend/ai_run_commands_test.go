package backend

import "testing"

func TestCanonicalReplayAttachmentIDs(t *testing.T) {
	emptyHash := func(value []string) string {
		t.Helper()
		hash, err := snapshotHash(canonicalReplayAttachmentIDs(value))
		if err != nil {
			t.Fatalf("hash attachment IDs: %v", err)
		}
		return hash
	}

	if nilHash, emptyHash := emptyHash(nil), emptyHash([]string{}); nilHash != emptyHash {
		t.Fatal("nil and empty attachment lists must have the same replay hash")
	}

	first := emptyHash([]string{"test_attachment_a"})
	if same := emptyHash([]string{"test_attachment_a"}); first != same {
		t.Fatal("identical non-empty attachment lists must retain the same replay hash")
	}
	if changed := emptyHash([]string{"test_attachment_b"}); first == changed {
		t.Fatal("a non-empty attachment change must retain a distinct replay hash")
	}
}
