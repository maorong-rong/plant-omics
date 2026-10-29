/**
 * DSH 插件出口 —— **薄壳**（0.1.0 形态）。
 *
 * 这里**刻意不注册任何工具**：工具由远程 MCP 服务提供，
 * 通过本包 `cordis.patch.yml` 里那条 `@deepseek-ai/dsh-mcp-client` 条目接入。
 *
 * 为什么不再内置工具：
 *   插件内置工具意味着每接一个源就要发一次新包、用户要重装；
 *   薄壳之后，新源只更新服务端，客户端重连即可拿到新工具。
 *
 * 因此下面这些旧东西全部删掉了，且不该被"顺手加回来"：
 *   - 本地注册表（`createRegistry`）：插件不需要知道有哪些源；
 *   - `toDshTool` / `registerAll`：插件不再是工具宿主；
 *   - "全部工具注册失败就抛"这类分支：没有工具可注册，这条语义已无对象。
 *
 * 保留的是：面板（浏览器半边，由 `dsh.client` 与 `src/client/bundle.js` 提供）
 * 与本模块的装配日志——"插件装了但没反应"时，那是唯一的痕迹。
 */

export interface PlantOmicsPluginConfig {
  /** 关掉插件而不必卸载它 */
  enabled?: boolean;
  /** 打开后往 dsh 日志写装配信息，排查「面板没出现」时用 */
  debug?: boolean;
}

export const name = 'plant-omics';
export const inject: string[] = [];

interface PluginContext {
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
}

export function apply(ctx: PluginContext, rawConfig: PlantOmicsPluginConfig = {}): void {
  const config: PlantOmicsPluginConfig = { enabled: true, debug: false, ...rawConfig };
  const log = (...args: unknown[]): void => {
    if (config.debug) ctx.logger?.info?.('[plant-omics]', ...args);
  };

  if (!config.enabled) {
    log('配置为 enabled=false，跳过装配');
    return;
  }

  // 这里**不做任何工具注册**，也不去取 tools 服务：
  // 工具由 MCP 客户端条目提供，插件再注册一次等于把两套真相塞回来。
  log('薄插件已装配：工具由 MCP 服务提供，本模块不注册工具');
}

export default { name, inject, apply };
