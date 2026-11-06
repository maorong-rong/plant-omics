/**
 * UniProt 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：查询是 `accession:P46290` 且 `size=1`，
 * 因此响应 `results` 里的 `primaryAccession` 必须与请求的 P46290 逐字一致。
 * 只核验“身份与请求一致 + 基本结构”，不断言蛋白名、物种、长度等内容。
 */
const REQUESTED_ACCESSION = 'P46290';

export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('UniProt probe: 期望顶层为对象（search 响应是 {results: [...]}）');
  }
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.results)) throw new Error('UniProt probe: 缺少 results 数组');
  if (body.results.length === 0) throw new Error('UniProt probe: results 为空，探活未拿到记录');
  const first = body.results[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    throw new Error('UniProt probe: results[0] 不是对象');
  }
  const entry = first as Record<string, unknown>;
  if (!('primaryAccession' in entry)) throw new Error('UniProt probe: 记录缺少身份字段 primaryAccession');
  if (String(entry.primaryAccession) !== REQUESTED_ACCESSION) {
    throw new Error(
      `UniProt probe: 响应 primaryAccession=${String(entry.primaryAccession)} 与请求 ${REQUESTED_ACCESSION} 不一致`,
    );
  }
  if (typeof entry.entryType !== 'string' || !entry.entryType.trim()) {
    throw new Error('UniProt probe: entryType 必须是非空字符串');
  }
}
