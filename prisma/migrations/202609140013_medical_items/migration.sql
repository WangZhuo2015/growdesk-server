ALTER TABLE public.medical_reports ADD COLUMN items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.medical_reports ADD CONSTRAINT medical_reports_items_array CHECK (jsonb_typeof(items) = 'array');
