/**
 * DSH 插件出口。
 *
 * 契约（照 dsh-plugin-workbuddy 的实装形态写，2026-10-27 核对）：
 *   - 模块导出 `name` / `inject` / `apply(ctx, config)`，并 default 导出同名对象；
 *   - 工具通过 `ctx.useService('tools', tools => tools.register(def))` 注册，
 *     拿服务的标准写法是 `ctx.inject([name], cb)`，不保证 tools 比本插件先挂载；
 *   - 一个工具 = { name, description, parameters, output:{schema, render}, execute }，
 *     execute 的返回值必须是 JsonValue，模型看到的文本由 output.render 产出。
 *
 * 本文件刻意**不 import 任何 `@deepseek-ai/*` 包**：profile 的 node_modules 里
 * 解析不到它们，靠鸭子类型走通即可（同 workbuddy 的做法）。
 */

import { PlantOmicsError, describeError } from '../core/errors.js';
import { invokeTool } from '../core/invoke.js';
import type { ToolDefinition } from '../core/types.js';
import { createRegistry, registry as defaultRegistry } from '../sources/index.js';
import type { ToolRegistry } from '../core/registry.js';

interface ToolService {
  register(definition: unknown): void;
}

interface ServiceScope {
  tools?: ToolService;
  get?: (name: string) => unknown;
}

interface PluginContext {
  inject?: (names: string[], callback: (scope: ServiceScope) => void) => void;
  get?: (name: string) => unknown;
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
}

export interface PlantOmicsPluginConfig {
  /** 关掉插件而不必卸载它 */
  enabled?: boolean;
  /** 打开后会往 dsh 日志写注册信息，排查「工具没出现」时用 */
  debug?: boolean;
  /**
   * 只启用这些源 id（不传 = 全部）。
   * 对应「各团队独立入口」：同一份代码，各人只挂自己关心的库。
   */
  sources?: string[];
}

export const name = 'plant-omics';
export const inject: string[] = [];

const DSH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
} as const;

function toDshTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: DSH_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => {
        const text = (value as { text?: unknown } | null)?.text;
        return [{ type: 'text', text: typeof text === 'string' ? text : '' }];
      },
    },
    async execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }) {
      try {
        // 与 MCP 出口共用 invokeTool：入参校验、取消信号、取值路径完全一致
        const result = await invokeTool(tool, args ?? {}, { signal: exec?.signal });
        return { text: result.text };
      } catch (error) {
        // 抛出去＝让宿主按"工具失败"处理；但消息要和人话一致，
        // 不能把 UpstreamError 的裸对象丢给用户（审查 P1：两出口说法不一）
        throw new Error(`${tool.name} 调用失败：${describeError(error)}`);
      }
    },
  };
}

export function apply(
  ctx: PluginContext,
  rawConfig: PlantOmicsPluginConfig = {},
  registry: ToolRegistry = defaultRegistry,
): void {
  const config: PlantOmicsPluginConfig = { enabled: true, debug: false, ...rawConfig };
  const log = (...args: unknown[]): void => {
    if (config.debug) ctx.logger?.info?.('[plant-omics]', ...args);
  };

  if (!config.enabled) {
    log('配置为 enabled=false，跳过注册');
    return;
  }

  /**
   * 确定性错误必须让宿主看得见（对抗性审查 R04 / A6）。
   *
   * 原来的做法是 `logger?.warn?.()` 然后**正常返回**——而 logger 本身是可选的，
   * 于是"插件启用了、但一个工具都没注册"这件事可以不留任何痕迹。
   * 这与项目规则「断言失败必须抛异常 / 非零失败，不得只告警」直接冲突。
   * 现在：先尽最大努力留日志（可观测），再抛（不可忽略）。
   */
  const fail = (message: string): never => {
    ctx.logger?.warn?.(`[plant-omics] ${message}`);
    throw new PlantOmicsError(message);
  };

  // 配置里指定了 sources 就现造一个子集注册表；id 拼错必须炸，不许静默零工具。
  let active = registry;
  if (config.sources && config.sources.length > 0) {
    try {
      active = createRegistry({ enabled: config.sources });
    } catch (error) {
      fail(`sources 配置不生效：${describeError(error)}`);
    }
  }

  const tools = active.listTools();
  if (tools.length === 0) {
    fail('注册表里没有工具（通常是 sources 配置把全部源都筛掉了）');
  }

  const registerAll = (service: ToolService): void => {
    const failed: string[] = [];
    let ok = 0;
    for (const tool of tools) {
      try {
        service.register(toDshTool(tool));
        ok += 1;
      } catch (error) {
        failed.push(`${tool.name}: ${describeError(error)}`);
      }
    }
    log(`已注册 ${ok}/${tools.length} 个工具`);
    if (failed.length === 0) return;

    const detail = `有 ${failed.length}/${tools.length} 个工具注册失败，插件不做静默降级：\n${failed.join('\n')}`;
    ctx.logger?.warn?.(`[plant-omics] ${detail}`);
    // 部分失败：留下可用的那部分（局部失效不该升级成全局失效）；
    // 全部失败：插件等于没装，必须让宿主看得见。
    if (ok === 0) throw new PlantOmicsError(detail);
  };

  // 标准做法：等 tools 服务就绪再注册（它可能比本插件晚挂载）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      const service = scope?.tools ?? scope?.get?.('tools');
      if (!service) {
        // 这是宿主装配问题，不是我们的配置错；只告警不抛，
        // 免得一次服务时序问题把整个 DSH 拖下水。但**必须留下痕迹**。
        const note = '[plant-omics] tools 服务已就绪但取不到，工具未注册';
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(note);
        else throw new PlantOmicsError(note);
        return;
      }
      registerAll(service as ToolService);
    });
    return;
  }

  // 退化路径：老版本 ctx 没有 inject 时同步取，方便纯 Node 环境下的装配测试。
  const service = ctx.get?.('tools');
  if (!service) {
    const note = '[plant-omics] 没有 ctx.inject，也取不到 tools 服务，工具无法注册';
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn(note);
      return;
    }
    throw new PlantOmicsError(note);
  }
  registerAll(service as ToolService);
}

export default { name, inject, apply };
