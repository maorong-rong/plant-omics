import { describe, expect, it } from 'vitest';

import { renderReport } from '../scripts/check-market.mjs';

/**
 * 双闸入口的**汇报方向**测试。
 *
 * 为什么要单独测：`a && b` 只有一个 exit 1，跑的人不知道去改数字还是改措辞。
 * 这里锁的是"哪一种红说哪一种话"——数字红不许说成措辞问题，取数失败不许说成描述写错。
 * 纯函数，不联网、不跑子进程、不读 dist。
 */

const counts = {
  schemaVersion: 1,
  scope: 'published',
  sources: 7,
  sourceTools: 32,
  metaTools: 2,
  metaToolNames: ['hub_find_sources', 'hub_status'],
  tools: 34,
  perSource: [],
  buildInfo: null,
};

const numberOk = {
  ok: true,
  kind: 'ok',
  problems: [],
  counts,
  latest: '0.1.0',
  tarball: 'https://registry.npmjs.org/plantomics-hub/-/plantomics-hub-0.1.0.tgz',
  integrity: 'sha512-abc',
};
const wordingOk = { ok: true, output: '' };

describe('check:market 双闸汇报', () => {
  it('两道都绿：明确说双闸通过', () => {
    const text = renderReport({ number: numberOk, wording: wordingOk });
    expect(text).toContain('✅ 市场双闸通过');
    expect(text).toContain('7 源 / 34 工具');
    expect(text).not.toContain('❌');
  });

  it('只有数字不一致：点名数字闸，且提醒别去动措辞/发布包', () => {
    const text = renderReport({
      number: { ...numberOk, ok: false, kind: 'mismatch', problems: ['市场中文描述缺少现行数量短语「7 个…」'] },
      wording: wordingOk,
    });
    expect(text).toContain('数字闸红');
    expect(text).toContain('方向是**数字**');
    expect(text).not.toContain('方向是**措辞**');
  });

  it('只有措辞不一致：点名措辞闸，并说明「数字是绿的、别去动数字」', () => {
    const text = renderReport({
      number: numberOk,
      wording: { ok: false, output: '✗ 索引文案与 copy.json 不一致' },
    });
    expect(text).toContain('措辞闸红');
    expect(text).toContain('方向是**措辞**');
    expect(text).toContain('数字闸是绿的');
    expect(text).not.toContain('方向是**数字**');
  });

  it('取数失败不许报成「描述写错了」', () => {
    const text = renderReport({
      number: { ...numberOk, ok: false, kind: 'fetch-error', problems: ['fetch failed'], counts: null },
      wording: wordingOk,
    });
    expect(text).toContain('取不到发布口径');
    expect(text).toContain('这不是「描述写错了」');
    expect(text).toContain('数字闸没得出结论');
    expect(text).not.toContain('方向是**数字**');
  });

  it('两道都红：两条方向都给，不含糊', () => {
    const text = renderReport({
      number: { ...numberOk, ok: false, kind: 'mismatch', problems: ['x'] },
      wording: { ok: false, output: 'y' },
    });
    expect(text).toContain('数字闸 + 措辞闸红');
    expect(text).toContain('方向是**数字**');
    expect(text).toContain('方向是**措辞**');
  });
});
