import { describe, expect, it, vi } from 'vitest';

/**
 * 订阅集硬阈值的**入口对称性**（2026-11-01，对抗审查者 P1 的回归测试）。
 *
 * 病灶：同一个 81 工具的集合，走环境变量 `PLANTOMICS_SOURCES` 能起，
 * 走请求头 `x-plantomics-sources` 被 400 拒绝——因为只有请求头那条调了 assertSubsetBudget。
 * 用户看到的是"配置能起、请求被拒"，只会以为是个别入口的毛病。
 *
 * 这条测试不验证"80 通过、81 拒绝"（那是 budget 自己的单测），它验证的是
 * **两条入口是否走同一个校验函数、对同一组源得出同一个数**。
 * 做法：把阈值换成"超过 3 个工具即拒"，然后分别从两条入口进同一组源，必须都拒、且计数相同。
 */

const calls: number[] = [];

vi.mock('../src/service/budget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/service/budget.js')>();
  return {
    ...actual,
    assertSubsetBudget: (toolCount: number) => {
      calls.push(toolCount);
      if (toolCount > 3) throw new Error(`本次订阅集 ${toolCount} 个工具超过阈值 3`);
    },
  };
});

describe('订阅集阈值：环境变量入口与请求头入口对称', () => {
  it('同一组源，两条入口都拒绝，且交给校验函数的工具数相同', async () => {
    const { createRegistry } = await import('../src/sources/index.js');
    const { resolveSubset } = await import('../src/service/subset.js');

    calls.length = 0;
    // 入口 A：环境变量（MCP / DSH 出口装配注册表就是这条路）
    expect(() => createRegistry({ enabled: ['icg', 'scod'] })).toThrow(/超过阈值 3/);
    // 入口 B：请求头（HTTP 出口）
    expect(() => resolveSubset(createRegistry(), 'icg,scod')).toThrow(/超过阈值 3/);

    expect(calls).toHaveLength(2);
    expect(calls[0], '两条入口交给校验函数的工具数必须相同，否则就是两套口径').toBe(calls[1]);
    expect(calls[0]).toBeGreaterThan(3);
  });

  it('不指定订阅集（默认全库）不经过这条校验：默认集是软建议，只警示不拦截', async () => {
    const { createRegistry } = await import('../src/sources/index.js');
    calls.length = 0;
    const all = createRegistry();
    expect(all.listTools().length).toBeGreaterThan(3);
    expect(calls).toEqual([]);
  });

  it('请求头入口只校验一次（不重复调用，避免两处阈值）', async () => {
    const { createRegistry } = await import('../src/sources/index.js');
    const { resolveSubset } = await import('../src/service/subset.js');
    calls.length = 0;
    expect(() => resolveSubset(createRegistry(), 'icg')).toThrow(/超过阈值 3/);
    expect(calls).toHaveLength(1);
  });
});
