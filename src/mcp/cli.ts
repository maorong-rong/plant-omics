#!/usr/bin/env node
/**
 * `plant-omics-mcp` —— MCP 的 stdio 入口。
 *
 * 铁律：**stdout 只许走 MCP 协议帧**。任何一行调试输出落到 stdout 都会
 * 让客户端解析失败，且现象是「连上了但一个工具都没有」，极难查。
 * 所以这里的日志一律走 stderr。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main(): Promise<void> {
  // 刻意用动态 import：源的装配（含 PLANTOMICS_SOURCES 的 id 校验）发生在**导入期**，
  // 若用静态 import，配错一个源 id 就会变成「未捕获异常 + 一屏堆栈」，
  // 而用户真正需要看到的只有一句「未知的源 id：xxx，可用的是 yyy」。
  const [{ createMcpServer }, { registry }] = await Promise.all([
    import('./server.js'),
    import('../sources/index.js'),
  ]);

  const server = createMcpServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const sources = registry.listSources().map((bundle) => bundle.manifest.id).join(', ') || '(无)';
  process.stderr.write(
    `[plant-omics] MCP server ready｜工具 ${registry.listTools().length} 个｜源：${sources}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[plant-omics] 启动失败：${message}\n`);
  if (!(error instanceof Error) || error.name !== 'PlantOmicsError') {
    // 不是我们自己的配置错误，才附堆栈——否则堆栈只会淹没那句关键提示
    process.stderr.write(`[plant-omics] 原始错误：${error instanceof Error ? error.stack ?? '' : String(error)}\n`);
  }
  process.exitCode = 1;
});
