-- CreateTable: attachments
CREATE TABLE "public"."attachments" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT,
    "uploader_id" TEXT NOT NULL,
    "purpose" VARCHAR(50) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "object_key" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_attachments_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_attachments_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attachments_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 26214400),
    CONSTRAINT "attachments_status_check" CHECK ("status" IN ('pending', 'ready', 'failed')),
    CONSTRAINT "attachments_purpose_check" CHECK ("purpose" IN ('avatar', 'medical_report', 'voice_note', 'growth_photo'))
);

CREATE INDEX "ix_attachments_family_status" ON "public"."attachments"("family_id", "status");
CREATE INDEX "ix_attachments_baby_status" ON "public"."attachments"("baby_id", "status");
CREATE INDEX "ix_attachments_sha256" ON "public"."attachments"("sha256");

-- CreateTable: medical_reports
CREATE TABLE "public"."medical_reports" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "caregiver_id" TEXT NOT NULL,
    "report_date" DATE NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "hospital" VARCHAR(100),
    "department" VARCHAR(100),
    "diagnosis" VARCHAR(500),
    "notes" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_medical_reports_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_medical_reports_family_id_baby_id_fkey" FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_medical_reports_caregiver_id_fkey" FOREIGN KEY ("caregiver_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "medical_reports_version_check" CHECK ("version" > 0)
);

CREATE INDEX "ix_medical_reports_baby_timeline" ON "public"."medical_reports"("baby_id", "deleted_at", "report_date" DESC, "id" DESC);
CREATE INDEX "ix_medical_reports_family_timeline" ON "public"."medical_reports"("family_id", "deleted_at", "report_date" DESC);

-- CreateTable: medical_report_attachments
CREATE TABLE "public"."medical_report_attachments" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "attachment_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_report_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_medical_report_attachments_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "public"."medical_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_medical_report_attachments_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "uq_medical_report_attachments" UNIQUE ("report_id", "attachment_id")
);

-- CreateTable: vaccine_schedules
CREATE TABLE "public"."vaccine_schedules" (
    "id" TEXT NOT NULL,
    "vaccine_code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "recommended_age_months" INTEGER NOT NULL,
    "dose_number" INTEGER NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT FALSE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vaccine_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uq_vaccine_schedules_code_dose" UNIQUE ("vaccine_code", "dose_number"),
    CONSTRAINT "vaccine_schedules_age_check" CHECK ("recommended_age_months" >= 0),
    CONSTRAINT "vaccine_schedules_dose_check" CHECK ("dose_number" > 0)
);

-- CreateTable: vaccine_records
CREATE TABLE "public"."vaccine_records" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "caregiver_id" TEXT NOT NULL,
    "vaccine_code" VARCHAR(100) NOT NULL,
    "administered_date" DATE NOT NULL,
    "clinic" VARCHAR(200),
    "batch_number" VARCHAR(100),
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vaccine_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_vaccine_records_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_vaccine_records_family_id_baby_id_fkey" FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_vaccine_records_caregiver_id_fkey" FOREIGN KEY ("caregiver_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "vaccine_records_version_check" CHECK ("version" > 0)
);

CREATE INDEX "ix_vaccine_records_baby_timeline" ON "public"."vaccine_records"("baby_id", "deleted_at", "administered_date" DESC, "id" DESC);
CREATE INDEX "ix_vaccine_records_family_timeline" ON "public"."vaccine_records"("family_id", "deleted_at", "administered_date" DESC);

-- CreateTable: push_devices
CREATE TABLE "public"."push_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "installation_id" VARCHAR(128) NOT NULL,
    "platform" VARCHAR(20) NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "token" TEXT NOT NULL,
    "device_label" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "uq_push_devices_user_installation" UNIQUE ("user_id", "installation_id"),
    CONSTRAINT "push_devices_platform_check" CHECK ("platform" IN ('ios', 'web')),
    CONSTRAINT "push_devices_environment_check" CHECK ("environment" IN ('sandbox', 'production'))
);

CREATE INDEX "ix_push_devices_installation" ON "public"."push_devices"("installation_id");

-- CreateTable: notifications
CREATE TABLE "public"."notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_key" VARCHAR(100) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ix_notifications_user_timeline" ON "public"."notifications"("user_id", "read_at", "created_at" DESC, "id" DESC);
