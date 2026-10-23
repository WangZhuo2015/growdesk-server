-- CreateTable: formula_products
CREATE TABLE "formula_products" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" TEXT,
    "scoop_weight_g" DECIMAL(12, 5),
    "water_per_scoop_ml" DECIMAL(12, 5),
    "reconstitution_ratio" DECIMAL(12, 5),
    "serving_size_unit" TEXT NOT NULL DEFAULT 'per_100g',
    "nutrients_json" JSONB,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "formula_products_pkey" PRIMARY KEY ("id")
);

-- Foreign Keys
ALTER TABLE "formula_products"
    ADD CONSTRAINT "formula_products_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "feeding_records"
    ADD CONSTRAINT "feeding_records_formula_product_id_fkey" FOREIGN KEY ("formula_product_id") REFERENCES "formula_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Expand FeedingType check constraint to allow canonical types ('breast', 'bottle', 'formula') as well as legacy granular values
ALTER TABLE "feeding_records" DROP CONSTRAINT IF EXISTS "feeding_records_feeding_type_check";
ALTER TABLE "feeding_records" ADD CONSTRAINT "feeding_records_feeding_type_check"
    CHECK ("feeding_type" IN ('breast', 'bottle', 'formula', 'breast_left', 'breast_right', 'breast_both', 'bottle_breast_milk', 'bottle_formula', 'water'));

-- Indexes
CREATE INDEX "ix_formula_products_family" ON "formula_products"("family_id", "is_archived", "deleted_at");
