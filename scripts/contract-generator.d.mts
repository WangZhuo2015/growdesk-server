export function transformOpenApi(spec: unknown): unknown;
export function buildContractApp(): Promise<unknown>;
export function generateCanonicalOpenApi(): Promise<{
  openapi: string;
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
}>;
