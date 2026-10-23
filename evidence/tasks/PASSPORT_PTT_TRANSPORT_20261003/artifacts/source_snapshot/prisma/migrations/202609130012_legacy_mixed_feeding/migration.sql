-- Additive migration: retain every previously accepted value and preserve mixed feeding.
-- Do not rewrite 202609120003_care_feeding or reinterpret existing records as formula.
ALTER TABLE "feeding_records" DROP CONSTRAINT "feeding_records_feeding_type_check";
ALTER TABLE "feeding_records" ADD CONSTRAINT "feeding_records_feeding_type_check"
  CHECK ("feeding_type" IN (
    'breast', 'bottle', 'formula', 'mixed',
    'breast_left', 'breast_right', 'breast_both',
    'bottle_breast_milk', 'bottle_formula', 'water'
  ));
