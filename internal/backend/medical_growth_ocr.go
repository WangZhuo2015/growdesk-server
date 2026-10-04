package backend

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

const medicalOCRPrompt = "Extract a typed medical report draft from the attached medical document. Return one JSON object with text containing only the transcribed source text, actions as an empty array, and ocrDraft matching MedicalOcrDraft. Each field has value, confidence (0..1 or null), and uncertainty; unknown values are null with an explanation. Preserve printed test names, values, units, reference ranges, statuses and interpretation text. Set growthData null unless measurements are visibly present. Never diagnose, recommend treatment, infer missing values, or execute writes."

const growthOCRPrompt = "Extract a typed growth-measurement draft from the attached baby growth photo. Return one JSON object with text containing only transcribed source text, actions as an empty array, and ocrDraft matching GrowthOcrDraft. Each field has value, confidence (0..1 or null), and uncertainty; measurement fields also include sourceValue and sourceUnit. Convert only clearly identified kg/g to kg and cm/mm to cm, as decimal strings. If a reading or unit is unclear, set the normalized value null and explain uncertainty. Never diagnose, calculate percentiles, infer missing values, or execute writes."

func supportedOCRMime(kind, mime string) bool {
	switch kind {
	case "medical_ocr":
		return mime == "image/jpeg" || mime == "image/png" || mime == "image/webp" || mime == "application/pdf"
	case "growth_ocr":
		return mime == "image/jpeg" || mime == "image/png" || mime == "image/webp"
	default:
		return false
	}
}

func validateTypedOCRDraft(contract *Contract, kind string, draft Object) error {
	name := ""
	switch kind {
	case "medical_ocr":
		name = "MedicalOcrDraft"
	case "growth_ocr":
		name = "GrowthOcrDraft"
	default:
		return errors.New("unsupported OCR draft kind")
	}
	ref := contract.Document.Components.Schemas[name]
	if ref == nil || ref.Value == nil {
		return errors.New("typed OCR draft schema is missing from the generated contract")
	}
	if err := ref.Value.VisitJSON(schemaJSONValue(draft), wireFormats...); err != nil {
		return providerFailure("AI_PROVIDER_INVALID_RESPONSE", "OCR provider returned an invalid typed draft", false)
	}
	return nil
}

func canonicalTypedOCRDraft(contract *Contract, kind string, raw Object, input nativeTaskInput, sourceText, modelSource string) (Object, error) {
	if raw == nil || len(input.AttachmentIDs) != 1 || sourceText == "" {
		return nil, providerFailure("AI_PROVIDER_INVALID_RESPONSE", "OCR provider omitted the typed extraction or source text", false)
	}
	draft := copyObject(raw)
	draft["schemaVersion"] = float64(1)
	draft["attachmentId"] = input.AttachmentIDs[0]
	draft["modelSource"] = modelSource
	draft["sourceText"] = sourceText
	if kind == "medical_ocr" {
		draft["kind"] = "medical"
	} else if kind == "growth_ocr" {
		draft["kind"] = "growth"
	}
	if err := validateTypedOCRDraft(contract, kind, draft); err != nil {
		return nil, err
	}
	return draft, nil
}

// A record-create call is the explicit user confirmation boundary. The OCR
// task is read-only; this check only accepts its immutable successful result
// when the authenticated principal, family, baby and ready source attachment
// all match the record being created.
func validateConfirmedOCRRun(ctx context.Context, tx pgx.Tx, userID string, scope Scope, runID, expectedKind, attachmentID string, attachedIDs []string) error {
	if runID == "" {
		return apiError(400, "OCR_RUN_REQUIRED", "OCR run identifier is required")
	}
	row, err := one(ctx, tx, `SELECT to_jsonb(r) || jsonb_build_object('__task',to_jsonb(t),'__payload',o.payload)
		FROM ai_runs r JOIN task_executions t ON t.id=r.id
		LEFT JOIN LATERAL (SELECT payload FROM task_outbox WHERE aggregate_id=t.id AND phase_key='native-initial' ORDER BY created_at,id LIMIT 1) o ON true
		WHERE r.id=$1 AND r.user_id=$2`, runID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("AiRun", runID)
	}
	if err != nil {
		return err
	}
	task := obj(row["__task"])
	if text(task["kind"]) != expectedKind || text(task["status"]) != "succeeded" {
		return apiError(409, "OCR_RUN_NOT_READY", "OCR run must succeed before its draft can be saved")
	}
	if text(row["baby_id"]) != scope.BabyID {
		return apiError(409, "OCR_RUN_SCOPE_MISMATCH", "OCR run belongs to a different baby")
	}
	draft := obj(row["ocr_draft"])
	if draft == nil {
		return apiError(409, "OCR_RUN_NOT_READY", "OCR run has no successful typed extraction")
	}
	sourceAttachmentID := text(draft["attachmentId"])
	if attachmentID != "" && sourceAttachmentID != attachmentID {
		return apiError(409, "OCR_RUN_ATTACHMENT_MISMATCH", "OCR result does not match the record attachment")
	}
	if attachmentID == "" {
		for _, id := range attachedIDs {
			if id == sourceAttachmentID {
				attachmentID = id
				break
			}
		}
		if attachmentID == "" {
			return apiError(400, "OCR_ATTACHMENT_REQUIRED", "Explicit OCR confirmation must retain its source attachment")
		}
	}
	taskRow := copyObject(task)
	taskRow["payload"] = row["__payload"]
	input, err := decodeNativeTaskInput(taskRow)
	if err != nil {
		return apiError(409, "OCR_RUN_NOT_READY", "OCR run has no valid retained input")
	}
	if input.UserID != userID || input.FamilyID != scope.FamilyID || input.BabyID != scope.BabyID || len(input.AttachmentIDs) != 1 || input.AttachmentIDs[0] != attachmentID {
		return apiError(409, "OCR_RUN_SCOPE_MISMATCH", "OCR run scope or source attachment changed")
	}
	attachment, err := one(ctx, tx, `SELECT to_jsonb(a) FROM attachments a WHERE id=$1 AND family_id=$2 AND baby_id=$3 AND status='ready' AND deleted_at IS NULL`,
		attachmentID, scope.FamilyID, scope.BabyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("Attachment", attachmentID)
	}
	if err != nil {
		return err
	}
	if text(attachment["purpose"]) != expectedOCRPurpose(expectedKind) || !supportedOCRMime(expectedKind, text(attachment["mime_type"])) {
		return apiError(409, "OCR_ATTACHMENT_NOT_USABLE", "OCR source attachment is no longer valid for this draft")
	}
	return nil
}

func expectedOCRPurpose(kind string) string {
	if kind == "growth_ocr" {
		return "growth_photo"
	}
	return "medical_report"
}
