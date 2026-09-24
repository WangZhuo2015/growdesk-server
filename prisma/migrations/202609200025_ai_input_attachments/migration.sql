ALTER TABLE public.attachments
  DROP CONSTRAINT IF EXISTS attachments_purpose_check;

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_purpose_check
  CHECK (purpose IN ('avatar', 'medical_report', 'voice_note', 'growth_photo', 'ai_input'));
