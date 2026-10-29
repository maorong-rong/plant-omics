#!/usr/bin/env node
/**
 * `plantomics-hub serve` —— Streamable HTTP 服务入口。
 *
 * 与 stdio 出口的区别：这里**不**和宿主共享标准流，所以日志可以直接写 stderr，
 * 但同样遵守"不打印参数值"：出处尾注里含完整查询串，日志替它泄密等于前功尽弃。
 *
 * 启动顺序刻意固定：先读配置 → 再装配源 → 再跑预算门禁 → 最后才监听端口。
 * 任何一步失败都不该出现"端口开着但服务不可用"的中间态。
 */

async function main(): Promise<void> {
  process.stderr.write('[plantomics-hub] 正在读取配置…\n');

  const [{ parseServiceConfig }, { createService }, { registry }] = await Promise.all([
    import('../service/config.js'),
    import('../service/http.js'),
    import('../sources/index.js'),
  ]);

  const config = parseServiceConfig();
  const service = createService({
    registry,
    config,
    logger: (entry) => {
      // 只记方法名与工具名，绝不记参数
      const tool = entry.tool ? ` tool=${entry.tool}` : '';
      process.stderr.write(
        `[plantomics-hub] ${entry.at} ${entry.method} ${entry.rpc}${tool} → ${entry.status} ${entry.ms}ms\n`,
      );
    },
  });

  const running = await service.start();
  const sources = registry.listSources().map((b) => b.manifest.id).join(', ');
  process.stderr.write(
    `[plantomics-hub] 服务就绪 ${running.url}\n` +
      `[plantomics-hub] 源 ${running.budget.sources}/20 · 工具 ${running.budget.tools}/40 · 工具名预算 ${running.budget.nameBudget} 字符\n` +
      `[plantomics-hub] 源清单：${sources || '(无)'}\n` +
      `[plantomics-hub] 鉴权：${config.token ? 'Bearer token 已启用' : '未启用（仅回环绑定）'}\n`,
  );

  const shutdown = (signal: string): void => {
    process.stderr.write(`[plantomics-hub] 收到 ${signal}，关闭监听…\n`);
    void running.close().then(() => {
      process.stderr.write('[plantomics-hub] 已关闭\n');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[plantomics-hub] 启动失败：${message}\n`);
  // 预算门禁/配置错误的消息本身就是给人看的；只有意料之外的错误才附堆栈
  const expected = error instanceof Error && ['BudgetError', 'ServiceConfigError', 'PlantOmicsError'].includes(error.name);
  if (!expected) process.stderr.write(`[plantomics-hub] 原始错误：${error instanceof Error ? error.stack ?? '' : String(error)}\n`);
  process.exitCode = 1;
});
