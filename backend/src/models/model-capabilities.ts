/** The closed set of model capabilities (day-7-8 contract §22.7). */
export const MODEL_CAPABILITIES = ['web-search', 'reasoning'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/**
 * Validates/normalizes a capability list from an admin payload: keeps only
 * known values, dedupes, preserves declaration order. Invalid values are
 * rejected by the DTO (`@IsIn(MODEL_CAPABILITIES, { each: true })`); this
 * normalizer is the service-level safety net and the single place that
 * defines how duplicates collapse.
 */
export function normalizeCapabilities(
  values: readonly string[] | undefined | null,
): ModelCapability[] {
  if (!values) return [];
  const unique = new Set<string>();
  for (const value of values) {
    if ((MODEL_CAPABILITIES as readonly string[]).includes(value)) {
      unique.add(value);
    }
  }
  return [...unique] as ModelCapability[];
}
