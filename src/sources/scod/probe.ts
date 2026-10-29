import { UpstreamShapeError } from '../../core/errors.js';
import { manifest } from './manifest.js';

/** 只验证目录端点；不把一次目录probe称为全部业务可用。 */
export function validateProbe(payload: unknown): void {
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const r = item as Record<string, unknown>;
    return typeof r.genomeId !== 'number' || !Number.isSafeInteger(r.genomeId) || r.genomeId < 1
      || typeof r.name !== 'string' || !r.name.trim() || typeof r.species !== 'string' || !r.species.trim();
  })) {
    throw new UpstreamShapeError('SCOD目录probe结构不符合已测裸数组契约', { url: `${manifest.apiBase}/genome/list?term=` });
  }
}
