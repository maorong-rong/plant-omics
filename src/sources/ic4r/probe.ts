/**
 * IC4R 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：`/gene/IC4R-OSJ01G000600`。
 * 只核验“请求与响应身份一致 + 基本结构”，不断言描述文本、基因长度等内容（那是数据快照）。
 */
export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('IC4R probe: 期望顶层为非数组对象（空响应或数组都不是正常基因记录）');
  }
  const record = payload as Record<string, unknown>;
  if (!('locus' in record)) throw new Error('IC4R probe: 缺少身份字段 locus');
  if (String(record.locus) !== 'IC4R-OSJ01G000600') {
    throw new Error(`IC4R probe: 响应 locus=${String(record.locus)} 与请求 IC4R-OSJ01G000600 不一致`);
  }
  if (!('chromosome' in record)) throw new Error('IC4R probe: 缺少 chromosome 字段');
}
