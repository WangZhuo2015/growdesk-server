package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestDeviceSyncImportManifestHashIsStableAndOrdered(t *testing.T) {
	first := deviceSyncChunkDescriptor{ID: "00000000-0000-4000-8000-000000000001", Index: 0, ItemCount: 2, RequestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	second := deviceSyncChunkDescriptor{ID: "00000000-0000-4000-8000-000000000002", Index: 1, ItemCount: 1, RequestHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	forward := deviceSyncImportManifestHash([]deviceSyncChunkDescriptor{first, second})
	reversed := deviceSyncImportManifestHash([]deviceSyncChunkDescriptor{second, first})
	if forward != reversed {
		t.Fatal("manifest hashing must use the protocol chunk index, not caller slice order")
	}
	want := sha256.Sum256([]byte(deviceSyncImportManifestPrefix +
		"0:00000000-0000-4000-8000-000000000001:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2\n" +
		"1:00000000-0000-4000-8000-000000000002:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:1\n"))
	if forward != hex.EncodeToString(want[:]) {
		t.Fatal("manifest hash does not match the documented canonical byte sequence")
	}
	emptyWant := sha256.Sum256([]byte(deviceSyncImportManifestPrefix))
	if got := deviceSyncImportManifestHash(nil); got != hex.EncodeToString(emptyWant[:]) {
		t.Fatal("explicit empty import plan does not have a stable manifest hash")
	}
}

func TestDeviceSyncImportManifestDescriptorsAreContiguousAndUnique(t *testing.T) {
	valid := []any{
		Object{"chunkId": "00000000-0000-4000-8000-000000000001", "index": 0, "itemCount": 1, "requestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		Object{"chunkId": "00000000-0000-4000-8000-000000000002", "index": 1, "itemCount": 1, "requestHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
	}
	if rows, count, err := parseDeviceSyncChunkDescriptors(valid); err != nil || len(rows) != 2 || count != 2 {
		t.Fatalf("valid manifest rejected: rows=%d count=%d err=%v", len(rows), count, err)
	}
	invalid := [][]any{
		{valid[0], Object{"chunkId": "00000000-0000-4000-8000-000000000003", "index": 2, "itemCount": 1, "requestHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}},
		{valid[0], Object{"chunkId": "00000000-0000-4000-8000-000000000001", "index": 1, "itemCount": 1, "requestHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}},
		{Object{"chunkId": "00000000-0000-4000-8000-000000000001", "index": 0, "itemCount": 0, "requestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},
	}
	for index, input := range invalid {
		if _, _, err := parseDeviceSyncChunkDescriptors(input); err == nil {
			t.Fatalf("invalid manifest variant %d was accepted", index)
		}
	}
}

func TestDeviceSyncImportRejectsAttachmentReferencesRecursively(t *testing.T) {
	if containsDeviceSyncAttachmentReference(Object{"nested": []any{Object{"attachmentIds": []any{"test_attachment"}}}}) == false {
		t.Fatal("nested attachmentIds were not recognized as unsupported import data")
	}
	if containsDeviceSyncAttachmentReference(Object{"attachmentId": "test_attachment"}) == false {
		t.Fatal("attachmentId was not recognized as unsupported import data")
	}
	if containsDeviceSyncAttachmentReference(Object{"attachmentId": nil, "attachments": []any{}, "notes": "test-only"}) {
		t.Fatal("empty attachment fields should not be treated as an attachment reference")
	}
}
