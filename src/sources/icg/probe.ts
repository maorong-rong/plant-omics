/**
 * ICG 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：路径是 `/api/json/species/ICG00115`。
 * 这里检查信封、身份对账与核心字段类型——不是物种数据快照：不断言 studyNumber 数值或描述文本。
 */
export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('ICG probe: 期望顶层为对象');
  }
  const envelope = payload as Record<string, unknown>;
  for (const key of ['code', 'result']) {
    if (!(key in envelope)) throw new Error(`ICG probe: 缺少信封字段 ${key}`);
  }
  if (typeof envelope.code !== 'string') throw new Error('ICG probe: code 必须是字符串');
  if (envelope.code !== '200') throw new Error(`ICG probe: code=${envelope.code}（非 200，探活不应命中查无或错误信封）`);
  const result = envelope.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('ICG probe: result 必须是对象');
  }
  const species = result as Record<string, unknown>;
  if (Object.keys(species).length === 0) throw new Error('ICG probe: result 是空对象');
  if (String(species.accession) !== 'ICG00115') {
    throw new Error(`ICG probe: result.accession=${String(species.accession)} 与请求 ICG00115 不一致`);
  }
  for (const key of ['latinName', 'category']) {
    const value = species[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`ICG probe: result.${key} 必须是非空字符串`);
  }
}
