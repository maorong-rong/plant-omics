/**
 * 置顶源顺序：**唯一来源**是 `src/core/pinned-sources.json`。
 *
 * 为什么单独一份 JSON 而不是各处写常量：`site/` 与 `src/client/` 都按这个顺序渲染，
 * 之前各写一份 `PINNED_SOURCE_IDS`，改一处就会两处不一致。数据放 JSON，代码只负责"读 + 校验 + 排序"。
 *
 * 校验都往"看得懂、能指路"的方向做：
 * - 文件缺失 → 明确说缺哪个文件、怎么补（不静默回退成注册表原序，那会让置顶悄悄失效）；
 * - 形状不对（schemaVersion、pinned 类型、重复 id）→ 抛错并点名；
 * - id 不在注册表里 → 由调用方（`src/client/catalog.ts`）用注册表核对后抛错，这里只管形状。
 */

import { readFileSync } from 'node:fs';

/** 置顶顺序的数据形状。改形状要升 `schemaVersion`，并同步 `dist` 的消费者。 */
export interface PinnedSources {
  readonly schemaVersion: number;
  /** 置顶源 id，数组顺序即展示顺序。未列出的源保持注册表原序。 */
  readonly pinned: readonly string[];
  readonly note?: string;
}

/** 当前支持的数据形状版本。 */
export const PINNED_SCHEMA_VERSION = 1;

/** 默认文件位置：与本模块同目录（`src/core/` 或 `dist/core/` 各有一份，构建时复制）。 */
export function pinnedSourcesUrl(): URL {
  return new URL('./pinned-sources.json', import.meta.url);
}

/** 给人和报错看的相对路径。 */
export const PINNED_SOURCES_SOURCE_PATH = 'src/core/pinned-sources.json';
export const PINNED_SOURCES_DIST_PATH = 'dist/core/pinned-sources.json';

const HINT = `置顶顺序的唯一来源是 ${PINNED_SOURCES_SOURCE_PATH}；它是构建产物的一部分，先跑 npm run build。`;

export function parsePinnedSources(raw: unknown, sourceLabel = PINNED_SOURCES_SOURCE_PATH): PinnedSources {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourceLabel} 不是 JSON 对象。${HINT}`);
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== PINNED_SCHEMA_VERSION) {
    throw new Error(
      `${sourceLabel} 的 schemaVersion 是 ${JSON.stringify(record.schemaVersion)}，本仓只认 ${PINNED_SCHEMA_VERSION}。${HINT}`,
    );
  }
  if (!Array.isArray(record.pinned)) {
    throw new Error(`${sourceLabel} 的 pinned 必须是字符串数组。${HINT}`);
  }
  const pinned = record.pinned.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${sourceLabel} 的 pinned 里有非字符串或空值：${JSON.stringify(entry)}。${HINT}`);
    }
    return entry.trim();
  });
  const duplicated = pinned.filter((id, index) => pinned.indexOf(id) !== index);
  if (duplicated.length > 0) {
    throw new Error(`${sourceLabel} 的 pinned 有重复 id：${[...new Set(duplicated)].join(', ')}。${HINT}`);
  }
  return { schemaVersion: PINNED_SCHEMA_VERSION, pinned, ...(typeof record.note === 'string' ? { note: record.note } : {}) };
}

/** 读文件并校验形状；文件缺失时抛错并指路，不回退。 */
export function loadPinnedSources(url: URL = pinnedSourcesUrl()): PinnedSources {
  let text: string;
  try {
    text = readFileSync(url, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`读不到 ${url.pathname}（${reason}）。${HINT}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${url.pathname} 不是合法 JSON（${reason}）。${HINT}`);
  }
  return parsePinnedSources(parsed, url.pathname);
}

/**
 * 按置顶清单重排：置顶项按清单顺序靠前，其余保持传入顺序（注册表原序）。
 *
 * 不在这里判"id 是否存在"——调用方手里才有注册表；但它必须把不存在的 id 当错误报出去。
 */
export function applyPinnedOrder<T extends { id: string }>(items: readonly T[], pinned: readonly string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const head = pinned.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
  const headIds = new Set(head.map((item) => item.id));
  const tail = items.filter((item) => !headIds.has(item.id));
  return [...head, ...tail];
}
