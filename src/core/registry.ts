/**
 * 源与工具的注册表。
 *
 * 这里的校验是**硬校验**（抛异常，不是打警告）——对应项目规则「断言必须非零退出」。
 * 一个源只要登记得不合规，进程就在启动时死掉，而不是在用户提问时给出半截答案。
 */

import { PlantOmicsError } from './errors.js';
import type { SourceBundle, SourceManifest, ToolDefinition } from './types.js';

const ID_PATTERN = /^[a-z][a-z0-9]*$/;
/** 元工具（不属于任何源，如检索层入口）的命名空间。 */
const META_PREFIX = 'hub_';
/** `hub_[a-z0-9_]*`：前缀固定，其余只允许小写字母/数字/下划线。 */
const META_NAME_PATTERN = /^hub_[a-z0-9_]+$/;
/**
 * 元工具名长度上限 = 宿主公开名预算（`mcp__plantomics-hub__` 21 字符 + 名字 43 = 64）。
 * 超了会被宿主静默截断加哈希，工具名不可预测，等同破坏契约，因此本地就拒绝。
 */
const META_NAME_MAX = 43;

export class ToolRegistry {
  readonly #sources = new Map<string, SourceBundle>();
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #metaTools = new Map<string, ToolDefinition>();

  /**
   * 注册**元工具**：不属于任何数据源（如 `hub_find_sources`）。
   *
   * 为什么不塞进伪源：伪源得编造 `apiBase`/`tier`/`probe`，还会把源数从 6 变 7，
   * 污染"源"的语义。也不放宽 `#assertTool` 的前缀校验——那是给所有源的放松，
   * 以后任何源后缀写错都可能混过去。这里单开一个口，规则只对元工具生效。
   *
   * 计入**工具**预算（共用 `#tools`，`listTools()` 自然包含），不计入源数。
   */
  registerMetaTool(tool: ToolDefinition): void {
    if (!tool.name.startsWith(META_PREFIX)) {
      throw new PlantOmicsError(
        `元工具 ${tool.name} 必须以 "${META_PREFIX}" 开头（元工具不属于任何源，靠前缀与源工具区分）`,
      );
    }
    if (!META_NAME_PATTERN.test(tool.name)) {
      throw new PlantOmicsError(
        `元工具名不合法：${tool.name}（须匹配 hub_[a-z0-9_]*，只允许小写字母/数字/下划线）`,
      );
    }
    if (tool.name.length > META_NAME_MAX) {
      throw new PlantOmicsError(
        `元工具名 ${tool.name}（${tool.name.length} 字符）超过 ${META_NAME_MAX} 字符预算；`
        + `公开名 mcp__<serverName>__${tool.name} 会被宿主截断加哈希，工具名不可预测`,
      );
    }
    if (tool.parameters.type !== 'object') {
      throw new PlantOmicsError(`元工具 ${tool.name} 的 parameters.type 必须是 object`);
    }
    if (!tool.description || tool.description.length < 10) {
      throw new PlantOmicsError(`元工具 ${tool.name} 的 description 太短，模型无法判断何时使用`);
    }
    if (this.#tools.has(tool.name)) {
      throw new PlantOmicsError(`工具名重复：${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    this.#metaTools.set(tool.name, tool);
  }

  register(bundle: SourceBundle): void {
    const { manifest, tools } = bundle;
    this.#assertManifest(manifest);

    if (this.#sources.has(manifest.id)) {
      throw new PlantOmicsError(`源 id 重复注册：${manifest.id}`);
    }
    if (manifest.tier === 'T3' && tools.length > 0) {
      throw new PlantOmicsError(
        `源 ${manifest.id} 标为 T3（无可编程入口），按规则不许提供工具；请先在 docs/源登记表.md 里改成 T1/T2 并给出实测依据`,
      );
    }
    if (manifest.tier !== 'T3' && tools.length === 0) {
      throw new PlantOmicsError(`源 ${manifest.id} 标为 ${manifest.tier} 却没有任何工具`);
    }

    // 先把这一批**全部校验完**再落库：否则中途抛错会留下"工具已进册、源没进册"的半成品
    const seen = new Set<string>();
    for (const tool of tools) {
      this.#assertTool(manifest, tool);
      if (this.#tools.has(tool.name) || seen.has(tool.name)) {
        throw new PlantOmicsError(`工具名重复：${tool.name}`);
      }
      seen.add(tool.name);
    }

    for (const tool of tools) this.#tools.set(tool.name, tool);
    this.#sources.set(manifest.id, { manifest, tools, validateProbe: bundle.validateProbe });
  }

  #assertManifest(manifest: SourceManifest): void {
    if (!ID_PATTERN.test(manifest.id)) {
      throw new PlantOmicsError(`源 id 不合法：${manifest.id}（只允许小写字母与数字，首字符为字母）`);
    }
    if (!manifest.apiBase.startsWith('http')) {
      throw new PlantOmicsError(`源 ${manifest.id} 的 apiBase 必须以 http 开头`);
    }
    if (manifest.apiBase.endsWith('/')) {
      throw new PlantOmicsError(`源 ${manifest.id} 的 apiBase 不许以 / 结尾（拼路径时会出双斜杠）`);
    }
    if (manifest.tier === 'T1' && !manifest.docs) {
      throw new PlantOmicsError(`源 ${manifest.id} 标为 T1（有文档化接口）必须给出 docs 地址`);
    }
  }

  #assertTool(manifest: SourceManifest, tool: ToolDefinition): void {
    const prefix = `${manifest.id}_`;
    if (!tool.name.startsWith(prefix)) {
      throw new PlantOmicsError(`工具 ${tool.name} 必须以源 id 前缀 "${prefix}" 开头（跨源同名会让模型选错）`);
    }
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) {
      throw new PlantOmicsError(`工具名不合法：${tool.name}（小写字母/数字/下划线，3–64 字符）`);
    }
    if (tool.parameters.type !== 'object') {
      throw new PlantOmicsError(`工具 ${tool.name} 的 parameters.type 必须是 object`);
    }
    if (!tool.description || tool.description.length < 10) {
      throw new PlantOmicsError(`工具 ${tool.name} 的 description 太短，模型无法判断何时使用`);
    }
  }

  listSources(): SourceBundle[] {
    return [...this.#sources.values()];
  }

  listTools(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** 元工具（不属于任何源）；`listTools()` 里也包含它们。 */
  listMetaTools(): ToolDefinition[] {
    return [...this.#metaTools.values()];
  }

  getSource(id: string): SourceBundle | undefined {
    return this.#sources.get(id);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }
}
