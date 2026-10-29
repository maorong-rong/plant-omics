/**
 * Gramene 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：`/genes?idList=BGIOSGA001967` 返回数组，元素是基因文档。
 * 只核验“身份与请求一致 + 基本结构”，不断言描述文本、位置数值等内容。
 */
export function validateProbe(payload: unknown): void {
  if (!Array.isArray(payload)) {
    throw new Error('Gramene probe: /genes 应返回数组（空数组也说明端点变化，探活不应命中）');
  }
  if (payload.length === 0) throw new Error('Gramene probe: 返回空数组，探活未拿到记录');
  const first = payload[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    throw new Error('Gramene probe: 数组元素不是对象');
  }
  const doc = first as Record<string, unknown>;
  if (!('_id' in doc)) throw new Error('Gramene probe: 记录缺少身份字段 _id');
  if (String(doc._id) !== 'BGIOSGA001967') {
    throw new Error(`Gramene probe: 响应 _id=${String(doc._id)} 与请求 BGIOSGA001967 不一致`);
  }
}
