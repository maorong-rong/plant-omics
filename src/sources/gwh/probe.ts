/**
 * GWH 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：路径是 `/genome/1`，因此响应里的 `id` 必须是 "1"。
 * 这检查的是「请求与响应身份一致」，不是数据内容快照——不断言物种名、组装级别或基因组大小，
 * 那些换了记录就会误报。
 */
export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GWH probe: 期望顶层为对象');
  }
  const data = payload as Record<string, unknown>;
  for (const key of ['id', 'organism']) {
    if (!(key in data)) throw new Error(`GWH probe: 缺少身份字段 ${key}`);
  }
  if (data.id === null) throw new Error('GWH probe: id 为 null（查无响应），探活不应命中');
  if (String(data.id) !== '1') throw new Error(`GWH probe: 响应 id=${String(data.id)} 与请求 /genome/1 不一致`);
  if (typeof data.organism !== 'string' || !data.organism.trim()) {
    throw new Error('GWH probe: organism 必须是非空字符串');
  }
}
