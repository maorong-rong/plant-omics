/**
 * WheatOmics 源级探活断言（`npm run probe` 调用）。
 *
 * 与 manifest.probe.path 绑定：`/expression/projects` 是不带查询参数的目录端点，
 * 没有“请求侧身份”可对账。因此这里核验业务信封（success=true）、
 * `data.projects` 非空，以及每个项目都带非空字符串 `id`——只查字段存在或只看
 * “有 data 字段”都不算断言；不断言项目描述、分组或数量等内容。
 */
export function validateProbe(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('WheatOmics probe: 期望顶层为对象（{success, data} 信封）');
  }
  const envelope = payload as Record<string, unknown>;
  if (envelope.success !== true) {
    throw new Error(`WheatOmics probe: success=${String(envelope.success)}（探活不应命中失败信封）`);
  }
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('WheatOmics probe: data 必须是对象');
  }
  const projects = (data as Record<string, unknown>).projects;
  if (!Array.isArray(projects)) throw new Error('WheatOmics probe: data.projects 必须是数组');
  if (projects.length === 0) throw new Error('WheatOmics probe: data.projects 为空，未拿到表达项目');
  for (const [index, project] of projects.entries()) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error(`WheatOmics probe: data.projects[${index}] 不是对象`);
    }
    const id = (project as Record<string, unknown>).id;
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error(`WheatOmics probe: data.projects[${index}].id 必须是非空字符串`);
    }
  }
}
