import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { MAX_SOURCES, MAX_TOOLS, buildCatalog } from '../src/client/catalog.js';
import { createRegistry } from '../src/sources/index.js';

/**
 * 浏览器半边的离线测试。
 *
 * 能证明的：清单与注册表一致；bundle 的注册契约；**真实的打开/关闭/重开/卸载生命周期**
 * （用一个带 hook 状态、按 deps 跑 effect、会执行 cleanup 的最小运行时，而不是把 effect 置空）；
 * 关闭后焦点回到入口；样式节点与键盘监听在卸载时被清掉。
 *
 * 不能证明的：装进真实 DSH 后入口可见、页面可打开——那要装机后由人确认，
 * 不能用这些断言代替（项目规则 §十一「完成声明与证据层级一致」）。
 */

const root = process.cwd();
const bundleSource = readFileSync(path.join(root, 'src', 'client', 'bundle.js'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

type Element = { type: unknown; props: Record<string, unknown>; focus?: () => void };

/** 假 DOM：只实现样式注入与 portal 用得到的部分。 */
function createFakeDocument() {
  const head = {
    children: [] as Array<Record<string, unknown>>,
    appendChild(node: Record<string, unknown>) {
      node.parentNode = head;
      head.children.push(node);
    },
    removeChild(node: Record<string, unknown>) {
      head.children = head.children.filter((child) => child !== node);
      node.parentNode = null;
    },
  };
  const doc = {
    head,
    body: { tag: 'body' },
    documentElement: head,
    getElementById: (id: string) => head.children.find((child) => child.id === id) ?? null,
    createElement: (tag: string) => ({ tag, id: '', textContent: '', parentNode: null as unknown }),
  };
  return { doc, head };
}

let focusCalls: string[] = [];

function makeElement(
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
): Element {
  const merged = { ...(props ?? {}) } as Record<string, unknown>;
  merged.children = children.length === 0 ? undefined : children;
  const element: Element = { type, props: merged };
  element.focus = () => {
    focusCalls.push(String(merged.className ?? type));
  };
  const ref = merged.ref as { current?: unknown } | undefined;
  if (ref && typeof ref === 'object') ref.current = element;
  return element;
}

/**
 * 最小 hook 运行时（**按真实语义**，不是空壳）：
 *   - useState 存值，setter 改值，由测试显式触发重渲染；
 *   - useEffect 按 deps 判断跑不跑，跑之前先执行上一次的 cleanup；
 *   - unmount() 执行全部 cleanup —— 用来验「卸载时监听/样式是否清干净」。
 */
function createRuntime() {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const effects: Array<{ deps?: unknown[]; cleanup?: () => void } | undefined> = [];
  let index = 0;
  let pending: Array<{ i: number; fn: () => void | (() => void) }> = [];

  const begin = (): void => {
    index = 0;
    pending = [];
  };

  const useState = (initial: unknown): [unknown, (next: unknown) => void] => {
    const i = index;
    index += 1;
    if (!(i in states)) {
      states[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const set = (next: unknown): void => {
      states[i] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(states[i]) : next;
    };
    return [states[i], set];
  };

  const useRef = (initial: unknown): { current: unknown } => {
    const i = index;
    index += 1;
    if (!refs[i]) refs[i] = { current: initial };
    return refs[i] as { current: unknown };
  };

  const useEffect = (fn: () => void | (() => void), deps?: unknown[]): void => {
    const i = index;
    index += 1;
    const prev = effects[i];
    const changed =
      !prev ||
      !deps ||
      !prev.deps ||
      deps.length !== prev.deps.length ||
      deps.some((dep, position) => dep !== prev.deps?.[position]);
    if (!changed) return;
    if (typeof prev?.cleanup === 'function') prev.cleanup();
    effects[i] = { deps, cleanup: undefined };
    pending.push({ i, fn });
  };

  const flush = (): void => {
    for (const { i, fn } of pending) {
      const result = fn();
      effects[i] = { ...(effects[i] ?? {}), cleanup: typeof result === 'function' ? result : undefined };
    }
    pending = [];
  };

  const unmount = (): void => {
    for (const effect of effects) {
      if (typeof effect?.cleanup === 'function') effect.cleanup();
    }
  };

  return { begin, flush, unmount, useState, useEffect, useRef };
}

/** 遍历元素树（含 portal），按条件找节点。 */
function find(node: unknown, predicate: (el: Element) => boolean): Element | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const element = node as Element & { __portal?: unknown };
  if (predicate(element)) return element;
  if (element.__portal) {
    const hit = find(element.__portal, predicate);
    if (hit) return hit;
  }
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  for (const child of list) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return undefined;
}

const byClass = (className: string) => (el: Element) => el.props?.className === className;
const hasPortal = (el: Element) => Boolean((el as unknown as { __portal?: unknown }).__portal);

function loadBundle(options: { boot?: Record<string, unknown>; withDocument?: boolean } = {}) {
  const loaded: Array<{ id: string; factory: (req: (name: string) => unknown) => Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(event: { key?: string; target?: unknown; currentTarget?: unknown }) => void>>();
  const fake = createFakeDocument();
  focusCalls = [];

  const sandbox: Record<string, unknown> = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type: string, handler: (event: unknown) => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(handler as never);
    listeners.set(type, set);
  };
  sandbox.removeEventListener = (type: string, handler: (event: unknown) => void) => {
    listeners.get(type)?.delete(handler as never);
  };
  if (options.withDocument !== false) sandbox.document = fake.doc;
  sandbox.__ModuleLoader__ = {
    load: (registration: { id: string; factory: (req: (name: string) => unknown) => Record<string, unknown> }) => {
      loaded.push(registration);
    },
  };
  if (options.boot) sandbox.__PLANT_OMICS_CLIENT__ = options.boot;

  const emit = (type: string, event: { key?: string; target?: unknown; currentTarget?: unknown }) => {
    for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
  };

  vm.runInNewContext(bundleSource, sandbox, { filename: 'panel.js' });

  return { loaded, listeners, emit, head: fake.head, focusCalls: () => focusCalls };
}

const bootFor = (catalog: ReturnType<typeof buildCatalog>) => ({
  moduleId: pkg.name,
  packageVersion: pkg.version,
  builtAt: '2026-10-28T00:00:00.000Z',
  catalog,
});

describe('侧边栏静态清单', () => {
  it('清单与注册表逐项一致（源、工具、必填参数）', () => {
    const registry = createRegistry();
    const catalog = buildCatalog(registry);

    // 源顺序 = 置顶清单在前 + 其余注册表原序（顺序唯一来源是 src/core/pinned-sources.json）
    const pinned = catalog.pinned;
    const expectedSources = [
      ...pinned,
      ...registry.listSources().map((b) => b.manifest.id).filter((id) => !pinned.includes(id)),
    ];
    expect(catalog.sources.map((s) => s.id)).toEqual(expectedSources);
    expect(catalog.tools.map((t) => t.name)).toEqual(registry.listTools().map((t) => t.name));

    for (const source of catalog.sources) {
      const bundle = registry.getSource(source.id);
      expect(bundle).toBeDefined();
      expect(source.toolCount).toBe(bundle?.tools.length);
      expect(source.blindSpots).toEqual(bundle?.manifest.caveats ?? []);
    }

    for (const tool of catalog.tools) {
      const definition = registry.getTool(tool.name);
      expect(definition).toBeDefined();
      expect(tool.required).toEqual(definition?.parameters.required ?? []);
      // 元工具（sourceId=「元工具」）走 hub_ 前缀，不适用 <sourceId>_ 规则
      if (tool.sourceId === '元工具') {
        expect(tool.name.startsWith('hub_')).toBe(true);
        continue;
      }
      expect(tool.name.startsWith(`${tool.sourceId}_`)).toBe(true);
    }
  });

  it('预算口径与 scripts/counts.mjs 的常量一致（两边漂移就红）', () => {
    const countsSource = readFileSync(path.join(root, 'scripts', 'counts.mjs'), 'utf8');
    const readConst = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d+);`).exec(countsSource);
      if (!match?.[1]) throw new Error(`scripts/counts.mjs 里找不到 ${name}`);
      return Number(match[1]);
    };

    expect(MAX_SOURCES).toBe(readConst('MAX_SOURCES'));
    expect(MAX_TOOLS).toBe(readConst('MAX_TOOLS'));

    const catalog = buildCatalog(createRegistry());
    expect(catalog.budget.maxSources).toBe(MAX_SOURCES);
    expect(catalog.budget.maxTools).toBe(MAX_TOOLS);
    expect(catalog.budget.sources).toBe(catalog.sources.length);
    expect(catalog.budget.tools).toBe(catalog.tools.length);
  });

  it('清单不含任何探活/运行状态字段', () => {
    const catalog = buildCatalog(createRegistry());
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('lastProbe');
    expect(serialized).not.toContain('durationMs');
  });
});

describe('浏览器 bundle 的注册契约', () => {
  const fakeRequire = (name: string): unknown => {
    if (name === 'react') return { createElement: makeElement, Fragment: 'Fragment' };
    if (name === 'react-dom') return { createPortal: (node: unknown) => ({ __portal: node }) };
    throw new Error(`unexpected require: ${name}`);
  };

  it('加载期只注册 factory，不碰 DOM；id 与包名一致', () => {
    // 不提供 document：加载期若访问 DOM 会直接抛。
    const loaded = loadBundle({ withDocument: false }).loaded;
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe(pkg.name);
    expect(typeof loaded[0]?.factory).toBe('function');
  });

  it('模块导出形状符合客户端插件约定', () => {
    const moduleExports = loadBundle().loaded[0]?.factory(fakeRequire) as Record<string, unknown>;
    expect(moduleExports.name).toBe('plant-omics-client');
    expect(moduleExports.inject).toEqual(['slots']);
    expect(typeof moduleExports.apply).toBe('function');
    expect(moduleExports.moduleId).toBe(pkg.name);
  });

  it('apply 注册入口，卸载时移除槽位与注入的样式节点', () => {
    const env = loadBundle();
    const moduleExports = env.loaded[0]?.factory(fakeRequire) as Record<string, unknown>;
    const apply = moduleExports.apply as (ctx: unknown) => void;

    const registrations: Array<Record<string, unknown>> = [];
    const slotDispose = vi.fn();
    const slots = {
      register: (definition: Record<string, unknown>, component: unknown) => {
        registrations.push({ ...definition, component });
        return slotDispose;
      },
      inject: (name: string, callback: () => unknown) => {
        expect(name).toBe('sidebar.footer.action');
        return callback();
      },
    };

    let disposeMount: (() => void) | undefined;
    apply({
      slots,
      effect: (mount: () => void) => {
        disposeMount = mount();
      },
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.id).toBe('plant-omics');
    expect(typeof registrations[0]?.component).toBe('function');
    expect(env.head.children).toHaveLength(1);

    disposeMount?.();
    expect(slotDispose).toHaveBeenCalledTimes(1);
    expect(env.head.children).toHaveLength(0);
  });

  it('slots 服务缺失时只留痕、不抛（不把界面拖下水）', () => {
    const moduleExports = loadBundle().loaded[0]?.factory(fakeRequire) as Record<string, unknown>;
    const apply = moduleExports.apply as (ctx: unknown) => void;
    expect(() => apply({})).not.toThrow();
  });
});

describe('入口的生命周期', () => {
  const catalog = buildCatalog(createRegistry());

  function mountEntry() {
    const env = loadBundle({ boot: bootFor(catalog) });
    const runtime = createRuntime();
    const react = {
      createElement: makeElement,
      Fragment: 'Fragment',
      useState: runtime.useState,
      useEffect: runtime.useEffect,
      useRef: runtime.useRef,
    };
    const moduleExports = env.loaded[0]?.factory((name: string) => {
      if (name === 'react') return react;
      if (name === 'react-dom') return { createPortal: (node: unknown) => ({ __portal: node }) };
      throw new Error(`unexpected require: ${name}`);
    }) as Record<string, unknown>;
    const Entry = moduleExports.Entry as (props: { wide?: boolean }) => Element;

    const render = (): Element => {
      runtime.begin();
      const tree = Entry({ wide: true });
      runtime.flush();
      return tree;
    };

    return { env, runtime, render, moduleExports };
  }

  it('打开 → 关闭按钮关闭 → 监听归零、焦点回入口 → 可重开', () => {
    const { runtime, render, env } = mountEntry();

    let tree = render();
    expect(find(tree, hasPortal)).toBeUndefined();

    (find(tree, byClass('po-entry'))?.props.onClick as () => void)();
    tree = render();
    const portal = find(tree, hasPortal);
    expect(portal).toBeDefined();
    expect(env.listeners.get('keydown')?.size).toBe(1);

    // 关闭按钮路径：Panel 收到的 onClose 就是 Entry 的 close
    const panel = find(portal as unknown, (el) => typeof el.type === 'function');
    expect(panel).toBeDefined();
    (panel?.props.onClose as () => void)();

    tree = render();
    expect(find(tree, hasPortal)).toBeUndefined();
    expect(env.listeners.get('keydown')?.size).toBe(0);
    expect(env.focusCalls()).toContain('po-entry');

    // 重开：同一时刻仍只有一个监听
    (find(tree, byClass('po-entry'))?.props.onClick as () => void)();
    tree = render();
    expect(find(tree, hasPortal)).toBeDefined();
    expect(env.listeners.get('keydown')?.size).toBe(1);

    runtime.unmount();
    expect(env.listeners.get('keydown')?.size).toBe(0);
  });

  it('Esc 关闭：监听被移除、焦点回到入口', () => {
    const { runtime, render, env } = mountEntry();

    let tree = render();
    (find(tree, byClass('po-entry'))?.props.onClick as () => void)();
    tree = render();
    expect(env.listeners.get('keydown')?.size).toBe(1);

    env.emit('keydown', { key: 'Escape' });
    tree = render();

    expect(find(tree, hasPortal)).toBeUndefined();
    expect(env.listeners.get('keydown')?.size).toBe(0);
    expect(env.focusCalls()).toContain('po-entry');
    runtime.unmount();
  });

  it('打开状态下卸载：监听被清掉，不留残留', () => {
    const { runtime, render, env } = mountEntry();

    let tree = render();
    (find(tree, byClass('po-entry'))?.props.onClick as () => void)();
    tree = render();
    expect(env.listeners.get('keydown')?.size).toBe(1);

    runtime.unmount();
    expect(env.listeners.get('keydown')?.size).toBe(0);
  });

  it('遮罩只在点到本体时关闭', () => {
    const env = loadBundle({ boot: bootFor(catalog) });
    const runtime = createRuntime();
    const react = {
      createElement: makeElement,
      Fragment: 'Fragment',
      useState: runtime.useState,
      useEffect: runtime.useEffect,
      useRef: runtime.useRef,
    };
    const moduleExports = env.loaded[0]?.factory((name: string) => {
      if (name === 'react') return react;
      if (name === 'react-dom') return { createPortal: (node: unknown) => node };
      throw new Error(`unexpected require: ${name}`);
    }) as Record<string, unknown>;
    const Panel = moduleExports.Panel as (props: { model: unknown; onClose: () => void }) => Element;

    const onClose = vi.fn();
    runtime.begin();
    const tree = Panel({ model: { title: 't', note: 'n', sections: [] }, onClose });
    runtime.flush();

    const overlay = find(tree, byClass('po-overlay'));
    expect(overlay).toBeDefined();

    (overlay?.props.onMouseDown as (event: unknown) => void)({ target: {}, currentTarget: overlay });
    expect(onClose).not.toHaveBeenCalled();

    (overlay?.props.onMouseDown as (event: unknown) => void)({ target: overlay, currentTarget: overlay });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('面板打开时焦点落在关闭按钮', () => {
    const env = loadBundle({ boot: bootFor(catalog) });
    const runtime = createRuntime();
    const react = {
      createElement: makeElement,
      Fragment: 'Fragment',
      useState: runtime.useState,
      useEffect: runtime.useEffect,
      useRef: runtime.useRef,
    };
    const moduleExports = env.loaded[0]?.factory((name: string) => {
      if (name === 'react') return react;
      if (name === 'react-dom') return { createPortal: (node: unknown) => node };
      throw new Error(`unexpected require: ${name}`);
    }) as Record<string, unknown>;
    const Panel = moduleExports.Panel as (props: { model: unknown; onClose: () => void }) => Element;

    runtime.begin();
    Panel({ model: { title: 't', note: 'n', sections: [] }, onClose: () => {} });
    runtime.flush();

    expect(env.focusCalls()).toContain('po-close');
  });
});

describe('面板模型', () => {
  const catalog = buildCatalog(createRegistry());
  const boot = bootFor(catalog);
  const fakeRequire = (name: string): unknown => {
    if (name === 'react') return { createElement: makeElement, Fragment: 'Fragment' };
    if (name === 'react-dom') return { createPortal: (node: unknown) => ({ __portal: node }) };
    throw new Error(`unexpected require: ${name}`);
  };

  it('顶部状态行是「构建期清单 · N 源 / M 工具」，口径标在 title 上', () => {
    const moduleExports = loadBundle({ boot }).loaded[0]?.factory(fakeRequire) as Record<string, unknown>;
    const model = (moduleExports.buildPanelModel as (c: unknown, m: unknown) => {
      header: { status: string; statusTitle: string; snapshot: string };
      sources: Array<{ id: string; pinned: boolean }>;
    })(catalog, { sourceRev: 'deadbee' }, {});

    expect(model.header.status).toBe(`构建期清单 · ${catalog.sources.length} 源 / ${catalog.tools.length} 工具`);
    expect(model.header.statusTitle).toContain('不代表上游此刻可用');
    expect(model.header.snapshot).toBe('deadbee');
  });

  it('明确「不代表当前会话已启用」，不写「模型实际看到」', () => {
    const moduleExports = loadBundle({ boot }).loaded[0]?.factory(fakeRequire) as Record<string, unknown>;
    const model = (moduleExports.buildPanelModel as (c: unknown, m: unknown) => { header: { status: string; statusTitle: string } })(catalog, {
      sourceRev: 'deadbee',
    });
    const serialized = JSON.stringify(model);

    expect(serialized).toContain('不代表上游此刻可用');
    expect(serialized).not.toContain('模型实际看到');
  });

  it('源、工具、必填参数都出现在模型里（工具按源分组）', () => {
    const moduleExports = loadBundle({ boot }).loaded[0]?.factory(fakeRequire) as Record<string, unknown>;
    const model = (moduleExports.buildPanelModel as (c: unknown, m: unknown) => {
      sources: Array<{ id: string; name: string; toolNames: string[] }>;
      toolsBySource: Record<string, Array<{ name: string; whenToUse: string; required: string[] }>>;
    })(catalog, { sourceRev: 'deadbee' });

    for (const source of catalog.sources) {
      const entry = model.sources.find((item) => item.id === source.id);
      expect(entry?.name).toBe(source.displayName);
    }
    for (const tool of catalog.tools) {
      const bucket = model.toolsBySource[tool.sourceId];
      expect(bucket?.some((item) => item.name === tool.name)).toBe(true);
      if (tool.required.length > 0) {
        const found = bucket?.find((item) => item.name === tool.name);
        expect(found?.required).toEqual(tool.required);
      }
    }
    expect(JSON.stringify(model)).toContain('wheatomics_search_known_genes');
  });

  it('缺构建信息时如实写未知，不编造', () => {
    const moduleExports = loadBundle().loaded[0]?.factory(fakeRequire) as Record<string, unknown>;
    const model = (moduleExports.buildPanelModel as (c: unknown, m: unknown) => { header: { snapshot: string } })(catalog, {});
    expect(model.header.snapshot).toBe('未知');
  });
});

/**
 * 面板按 `web/PANEL-DESIGN.md` 接线后的验收点（v1 部分）。
 *
 * 这里只锁"模型里写了什么"这类离线可证的事；真实 DSH 面板的渲染要装机后另验，
 * 不能拿这些断言冒充。
 */
describe('面板设计稿接线（v1）', () => {
  type PanelModel = {
    state: string;
    header: { status: string; statusTitle: string; snapshot: string };
    sources: Array<{ id: string; name: string; pinned: boolean; toolCount: number; toolNames: string[]; icon: unknown }>;
    toolsBySource: Record<string, Array<{ name: string; whenToUse: string; required: string[] }>>;
    empty: { title: string; text: string };
    jump: { label: string; url: string | null; disabled: boolean; title: string };
  };
  type BuildModel = (c: unknown, m: unknown, icons?: unknown) => PanelModel;

  const localCatalog = buildCatalog(createRegistry());
  const modelFor = (bootOverride: Record<string, unknown> = {}, icons: unknown = {}) => {
    const loaded: Array<{ factory: (req: (name: string) => unknown) => Record<string, unknown> }> = [];
    const host = {
      __ModuleLoader__: {
        load: (entry: { factory: (req: (name: string) => unknown) => Record<string, unknown> }) => loaded.push(entry),
      },
      __PLANT_OMICS_CLIENT__: { moduleId: pkg.name, ...bootOverride },
    };
    vm.runInNewContext(bundleSource, { window: host, globalThis: host });
    const fakeRequireLocal = (name: string): unknown => {
      if (name === 'react') {
        return {
          createElement: () => null,
          Fragment: 'Fragment',
          useState: () => [null, () => {}],
          useEffect: () => {},
          useRef: () => ({ current: null }),
        };
      }
      if (name === 'react-dom') return { createPortal: (node: unknown) => node };
      throw new Error(`unexpected require: ${name}`);
    };
    const moduleExports = loaded[0]?.factory(fakeRequireLocal) as Record<string, unknown>;
    return (moduleExports.buildPanelModel as BuildModel)(localCatalog, {
      sourceRev: 'deadbee',
      webUrl: bootOverride.webUrl,
    }, icons);
  };

  it('源顺序与置顶跟清单一致：草莓第一，且标 pinned', () => {
    const model = modelFor();
    expect(model.sources[0]?.id).toBe('strawberry');
    expect(model.sources[0]?.pinned).toBe(true);
    expect(model.sources.filter((source) => source.pinned)).toHaveLength(1);
  });

  it('无快照时进空态：不出现任何计数', () => {
    const loaded: Array<{ factory: (req: (name: string) => unknown) => Record<string, unknown> }> = [];
    const host = {
      __ModuleLoader__: {
        load: (entry: { factory: (req: (name: string) => unknown) => Record<string, unknown> }) => loaded.push(entry),
      },
    };
    vm.runInNewContext(bundleSource, { window: host, globalThis: host });
    const moduleExports = loaded[0]?.factory((name: string) => {
      if (name === 'react') return { createElement: () => null, Fragment: 'Fragment', useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) };
      if (name === 'react-dom') return { createPortal: (node: unknown) => node };
      throw new Error(`unexpected require: ${name}`);
    }) as Record<string, unknown>;
    const model = (moduleExports.buildPanelModel as (c: unknown, m: unknown) => PanelModel)(undefined, {});
    expect(model.state).toBe('empty');
    expect(model.header.status).toBe('清单未注入');
    expect(model.sources).toEqual([]);
    expect(JSON.stringify(model)).not.toMatch(/\d+ 源/);
    expect(JSON.stringify(model)).not.toMatch(/\d+ 工具/);
    expect(model.empty.text).toContain('构建脚本没有产出 client catalog');
  });

  it('缺图标时给 null（面板显示 ? 占位），不静默消失', () => {
    const model = modelFor({}, {});
    expect(model.sources.every((source) => source.icon === null)).toBe(true);
  });

  it('未配置试调页地址时跳转按钮禁用并说明原因', () => {
    const disabled = modelFor();
    expect(disabled.jump.disabled).toBe(true);
    expect(disabled.jump.title).toContain('未配置');
    const enabled = modelFor({ webUrl: 'https://datamcp.moilab.net/' });
    expect(enabled.jump.disabled).toBe(false);
    expect(enabled.jump.url).toBe('https://datamcp.moilab.net/');
  });

  it('源码里不出现 token 片段或 Bearer 字面量', () => {
    const source = readFileSync(path.join(root, 'src', 'client', 'bundle.js'), 'utf8');
    expect(source).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(source).not.toMatch(/PLANTOMICS_HUB_TOKEN\s*[:=]\s*['"][^'"]+['"]/);
    expect(JSON.stringify(modelFor())).not.toMatch(/Bearer/);
  });
});
