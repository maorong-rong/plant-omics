/** GET /genes/status contract observed 2026-10-28T07:33:02Z.
 * Examples are evidence, not an exhaustive supported-species catalogue.
 */
export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Strawberry probe: expected top-level object');
  }
  const status = payload as Record<string, unknown>;
  for (const key of ['enabled', 'available'] as const) {
    if (typeof status[key] !== 'boolean') throw new Error(`Strawberry probe: ${key} must be boolean`);
    if (status[key] !== true) throw new Error(`Strawberry probe: ${key}=false`);
  }
  if (!Array.isArray(status.examples)) throw new Error('Strawberry probe: examples must be array');
  for (const [index, example] of status.examples.entries()) {
    if (!example || typeof example !== 'object' || Array.isArray(example)) {
      throw new Error(`Strawberry probe: examples[${index}] must be object`);
    }
    const row = example as Record<string, unknown>;
    for (const key of ['species', 'version', 'geneId']) {
      if (typeof row[key] !== 'string' || !row[key].trim()) {
        throw new Error(`Strawberry probe: examples[${index}].${key} must be non-empty string`);
      }
    }
  }
}
