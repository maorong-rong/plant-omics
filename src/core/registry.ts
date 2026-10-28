/**
 * 源与工具的注册表。
 *
 * 这里的校验是**硬校验**（抛异常，不是打警告）——对应项目规则「断言必须非零退出」。
 * 一个源只要登记得不合规，进程就在启动时死掉，而不是在用户提问时给出半截答案。
 */

import { PlantOmicsError } from './errors.js';
import type { SourceBundle, SourceManifest, ToolDefinition } from './types.js';

const ID_PATTERN = /^[a-z][a-z0-9]*$/;

export class ToolRegistry {
  readonly #sources = new Map<string, SourceBundle>();
  readonly #tools = new Map<string, ToolDefinition>();

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

  getSource(id: string): SourceBundle | undefined {
    return this.#sources.get(id);
  }

  getTool(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }
}
