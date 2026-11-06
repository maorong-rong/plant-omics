/**
 * Ensembl Plants 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：`/lookup/id/AT1G65480?content-type=application/json`
 * 请求的基因 ID 是 AT1G65480，因此响应里的 `id` 必须与它逐字一致。
 * 只核验“身份与请求一致 + 基本结构”，不断言描述文本、位置数值、组装版本等内容。
 */
const REQUESTED_ID = 'AT1G65480';

export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Ensembl Plants probe: /lookup/id 应返回对象（数组或 null 都不是正常基因记录）');
  }
  const record = payload as Record<string, unknown>;
  if (!('id' in record)) throw new Error('Ensembl Plants probe: 响应缺少身份字段 id');
  if (String(record.id) !== REQUESTED_ID) {
    throw new Error(`Ensembl Plants probe: 响应 id=${String(record.id)} 与请求 ${REQUESTED_ID} 不一致`);
  }
  if (typeof record.species !== 'string' || !record.species.trim()) {
    throw new Error('Ensembl Plants probe: species 必须是非空字符串');
  }
  if (typeof record.object_type !== 'string' || !record.object_type.trim()) {
    throw new Error('Ensembl Plants probe: object_type 必须是非空字符串');
  }
}
