import { BadRequestError } from "@growdesk/database";

export interface NormalizedSupplementNutrient {
  readonly amount: number;
  readonly unit: string;
}

export type NormalizedSupplementNutrients = Record<string, NormalizedSupplementNutrient>;

const STANDARD_UNITS: Readonly<Record<string, string>> = {
  vitamin_d: "IU",
  vitamin_a: "mcg RAE",
  vitamin_c: "mg",
  calcium: "mg",
  iron: "mg",
  zinc: "mg",
  dha: "mg",
  energy_kcal: "kcal",
  protein: "g",
};

const STANDARD_KEYS: Readonly<Record<string, string>> = {
  vitamind: "vitamin_d",
  vitamina: "vitamin_a",
  vitaminc: "vitamin_c",
};

/**
 * Keep the legacy MCP nutrient contract stable while ensuring only finite,
 * non-negative measurements reach the JSONB column.
 */
export function normalizeSupplementNutrients(raw: unknown): NormalizedSupplementNutrients {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const result: NormalizedSupplementNutrients = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const cleanKey = rawKey.trim().toLowerCase().replace(/-/g, "_");
    if (!cleanKey) continue;
    const key = STANDARD_KEYS[cleanKey] ?? cleanKey;
    const defaultUnit = STANDARD_UNITS[key] ?? "mg";

    if (typeof rawValue === "number") {
      if (Number.isFinite(rawValue) && rawValue >= 0) {
        result[key] = { amount: Number(rawValue.toFixed(2)), unit: defaultUnit };
      }
      continue;
    }

    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
    const value = rawValue as { amount?: unknown; unit?: unknown };
    if (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0) continue;
    const unit = typeof value.unit === "string" && value.unit.trim() ? value.unit.trim() : defaultUnit;
    result[key] = { amount: Number(value.amount.toFixed(2)), unit };
  }

  return result;
}

export function requireSupplementName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200) {
    throw new BadRequestError("Supplement name must contain 1 to 200 characters", "INVALID_SUPPLEMENT_NAME");
  }
  return name;
}

export function requireSupplementText(value: string | null | undefined, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text.length > maxLength) {
    throw new BadRequestError(`${field} is too long`, "INVALID_SUPPLEMENT_INPUT");
  }
  return text || null;
}

export function requireSupplementDose(value: string | number | undefined): string {
  const raw = value === undefined ? "1" : String(value).trim();
  const numeric = Number(raw);
  if (!raw || !Number.isFinite(numeric) || numeric <= 0 || numeric > 1_000_000) {
    throw new BadRequestError("defaultDose must be a positive finite number", "INVALID_SUPPLEMENT_DOSE");
  }
  return raw;
}
