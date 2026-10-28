// dsh-plugin-plant-omics —— 浏览器半边（手写 lazy-CJS bundle，不引 bundler）
//
// 形态依据（2026-10-28 读本机已装包）：
//   - dsh 的客户端模块系统是惰性 CJS：执行本文件只做一件事——把 factory 注册到
//     window.__ModuleLoader__；真正的副作用（取 React、注册槽位、注入样式）都在
//     factory 被物化时发生（@deepseek-ai/dsh-client-modules README）。
//   - id 必须等于 Loader 条目的包名（这里是 dsh-plugin-plant-omics），否则 web boot
//     会报 `bundle … loaded without registering "<id>"`。构建脚本注入并断言。
//   - 平台模块表里有 react / react-dom（官方 client bundle 用 require 取），
//     所以不需要 dsh.client.external，也不新增运行时依赖。
//
// 内容只有一个静态清单：源、工具、覆盖盲区、MCP 配置说明。
// **不显示任何运行状态**——构建期快照不等于上游当前可用。

(function () {
  'use strict';

  var BOOT =
    (typeof globalThis !== 'undefined' && globalThis.__PLANT_OMICS_CLIENT__) || {};
  var MODULE_ID = BOOT.moduleId || 'dsh-plugin-plant-omics';
  var META = {
    moduleId: MODULE_ID,
    packageVersion: BOOT.packageVersion || '未知',
    builtAt: BOOT.builtAt || '未知',
  };
  var CATALOG = BOOT.catalog || {
    schemaVersion: 0,
    budget: { sources: 0, maxSources: 20, tools: 0, maxTools: 40 },
    sources: [],
    tools: [],
  };

  /**
   * 面板的纯数据模型。刻意与 React 分开：
   * 测试不带 DOM 就能断言「面板上写了什么」，也让「静态」这句声明有唯一出处。
   */
  function buildPanelModel(catalog, meta) {
    var budget = catalog.budget || { sources: 0, maxSources: 20, tools: 0, maxTools: 40 };
    var sources = catalog.sources || [];
    var tools = catalog.tools || [];

    return {
      title: '植物组学 · 源与工具',
      note:
        '静态快照 · 构建于 ' +
        (meta && meta.builtAt ? meta.builtAt : '未知') +
        ' · 包版本 ' +
        (meta && meta.packageVersion ? meta.packageVersion : '未知') +
        ' · 不表示上游当前可用',
      sections: [
        {
          id: 'budget',
          heading: '预算',
          kind: 'kv',
          items: [
            { label: '源', value: budget.sources + ' / ' + budget.maxSources },
            { label: '工具', value: budget.tools + ' / ' + budget.maxTools },
            {
              label: '约束口径',
              value:
                budget.tools > budget.maxTools
                  ? '工具数已超上限：按项目规则必须先有检索层，不能再加源'
                  : '工具额度是紧约束（每源 4–8 个工具）',
            },
          ],
        },
        {
          id: 'sources',
          heading: '源与覆盖盲区',
          kind: 'list',
          items: sources.map(function (source) {
            var lines = [];
            lines.push('等级 ' + source.tier + ' · 工具 ' + source.toolCount + ' 个 · ' + source.homepage);
            if (source.species && source.species.length > 0) {
              lines.push('物种：' + source.species.join('、'));
            }
            var blindSpots = source.blindSpots || [];
            if (blindSpots.length > 0) {
              for (var i = 0; i < blindSpots.length; i += 1) lines.push('盲区：' + blindSpots[i]);
            } else {
              lines.push('盲区：未登记（不代表没有）');
            }
            lines.push('版本口径：' + (source.versionNote || '未知'));
            return { title: source.displayName + '（' + source.id + '）', lines: lines };
          }),
        },
        {
          id: 'tools',
          heading: '工具（本包包含）',
          kind: 'list',
          items: tools.map(function (tool) {
            var required = tool.required || [];
            return {
              title: tool.name,
              lines: [
                '何时用：' + tool.whenToUse,
                '必填参数：' + (required.length > 0 ? required.join(', ') : '无'),
              ],
            };
          }),
        },
        {
          id: 'mcp',
          heading: 'MCP 配置（Claude Code / Codex / Reasonix）',
          kind: 'code',
          text: JSON.stringify(
            {
              mcpServers: {
                'plant-omics': {
                  command: 'node',
                  args: ['<安装目录>/dist/mcp/cli.js'],
                },
              },
            },
            null,
            2,
          ),
          caption:
            '把 <安装目录> 换成本包的实际路径（可执行 npm root -g 或用本机 checkout）。'
            + '同一份工具定义，MCP 与 DSH 插件两个出口共用。',
        },
        {
          id: 'policy',
          heading: '口径',
          kind: 'text',
          text: [
            '这是一份构建期快照：列出的是「本版本装了哪些源和工具」，不是「上游现在能不能查」。',
            '也不代表当前会话已启用这些工具——是否注册取决于插件配置（如 sources 子集）与宿主状态，本面板不反映。',
            '真实可达性用 `npm run probe` 单独验证；那一步的结果不写进本面板。',
            '上游版本未提供就写「未知」，不按 ID 外观推测；引用前请回上游确认。',
            '本插件只读公开接口：不镜像数据、不绕过访问控制。',
          ],
        },
      ],
    };
  }

  function factory(require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var createPortal = require('react-dom').createPortal;
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var STYLE_ID = 'plant-omics-client-styles';
    var STYLE_TEXT = [
      '.po-entry{display:inline-flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;',
      'border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}',
      '.po-entry:hover{background:color-mix(in srgb,currentColor 10%,transparent)}',
      '.po-entry:focus-visible{outline:2px solid color-mix(in srgb,currentColor 45%,transparent);outline-offset:2px}',
      '.po-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;',
      'border-radius:6px;background:color-mix(in srgb,currentColor 14%,transparent);font-size:11px;font-weight:600}',
      '.po-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.po-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'padding:24px;background:rgba(0,0,0,.45)}',
      '.po-dialog{display:flex;flex-direction:column;width:min(880px,100%);max-height:min(85vh,760px);',
      'border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;background:Canvas;',
      'color:CanvasText;box-shadow:0 18px 60px rgba(0,0,0,.35);font:13px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.po-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 20px 12px;',
      'border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}',
      '.po-title{margin:0;font-size:16px;font-weight:600}',
      '.po-note{margin:4px 0 0;font-size:12px;opacity:.72}',
      '.po-close{border:0;border-radius:8px;background:transparent;color:inherit;font-size:18px;line-height:1;',
      'width:28px;height:28px;cursor:pointer}',
      '.po-close:hover{background:color-mix(in srgb,currentColor 12%,transparent)}',
      '.po-body{overflow:auto;padding:16px 20px 20px}',
      '.po-section{margin:0 0 22px}',
      '.po-section:last-child{margin-bottom:0}',
      '.po-h3{margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.02em;opacity:.9}',
      '.po-dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}',
      '.po-dt{opacity:.7}',
      '.po-dd{margin:0}',
      '.po-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}',
      '.po-item{border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:10px;padding:10px 12px}',
      '.po-item-title{font-weight:600;word-break:break-all}',
      '.po-item-line{margin:2px 0 0;opacity:.78;word-break:break-word}',
      '.po-code{margin:0;padding:10px 12px;border-radius:10px;overflow:auto;white-space:pre;',
      'background:color-mix(in srgb,CanvasText 8%,transparent);font:12px/1.55 ui-monospace,Consolas,monospace}',
      '.po-caption{margin:8px 0 0;font-size:12px;opacity:.72}',
      '.po-para{margin:0 0 6px;opacity:.82}',
    ].join('');

    function insertStyles() {
      if (typeof document === 'undefined') return function () {};
      if (document.getElementById(STYLE_ID)) return function () {};
      var node = document.createElement('style');
      node.id = STYLE_ID;
      node.textContent = STYLE_TEXT;
      (document.head || document.documentElement).appendChild(node);
      return function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      };
    }

    function renderSection(section) {
      var children = [h('h3', { className: 'po-h3', key: 'h' }, section.heading)];

      if (section.kind === 'kv') {
        var pairs = [];
        for (var i = 0; i < section.items.length; i += 1) {
          pairs.push(h('dt', { className: 'po-dt', key: 't' + i }, section.items[i].label));
          pairs.push(h('dd', { className: 'po-dd', key: 'd' + i }, section.items[i].value));
        }
        children.push(h('dl', { className: 'po-dl', key: 'dl' }, pairs));
      } else if (section.kind === 'list') {
        children.push(
          h(
            'ul',
            { className: 'po-list', key: 'ul' },
            section.items.map(function (item, index) {
              return h(
                'li',
                { className: 'po-item', key: 'li' + index },
                h('div', { className: 'po-item-title' }, item.title),
                item.lines.map(function (line, lineIndex) {
                  return h('p', { className: 'po-item-line', key: 'l' + lineIndex }, line);
                }),
              );
            }),
          ),
        );
      } else if (section.kind === 'code') {
        children.push(h('pre', { className: 'po-code', key: 'pre' }, h('code', null, section.text)));
        if (section.caption) children.push(h('p', { className: 'po-caption', key: 'cap' }, section.caption));
      } else {
        children.push(
          h(
            'div',
            { key: 'text' },
            section.text.map(function (line, index) {
              return h('p', { className: 'po-para', key: 'p' + index }, line);
            }),
          ),
        );
      }

      return h('section', { className: 'po-section', key: section.id }, children);
    }

    function Panel(props) {
      var model = props.model;
      var closeRef = useRef(null);

      useEffect(function () {
        if (closeRef.current && typeof closeRef.current.focus === 'function') {
          closeRef.current.focus();
        }
      }, []);

      return h(
        'div',
        {
          className: 'po-overlay',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          'div',
          {
            className: 'po-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': model.title,
          },
          h(
            'header',
            { className: 'po-head' },
            h(
              'div',
              null,
              h('h2', { className: 'po-title' }, model.title),
              h('p', { className: 'po-note' }, model.note),
            ),
            h(
              'button',
              {
                ref: closeRef,
                type: 'button',
                className: 'po-close',
                'aria-label': '关闭',
                onClick: props.onClose,
              },
              '×',
            ),
          ),
          h('div', { className: 'po-body' }, model.sections.map(renderSection)),
        ),
      );
    }

    /** 侧边栏入口。收起到 56px 轨道时只显示徽标（槽位传 { wide }）。 */
    function Entry(props) {
      var wide = !!(props && props.wide);
      var state = useState(false);
      var open = state[0];
      var setOpen = state[1];
      var entryRef = useRef(null);
      /** 是否「打开过」——用来区分首次渲染（不该抢焦点）与关闭（该把焦点还回去）。 */
      var wasOpen = useRef(false);
      var model = buildPanelModel(CATALOG, META);

      var close = function () {
        setOpen(false);
      };

      useEffect(
        function () {
          if (!open || typeof window === 'undefined') return undefined;
          var onKeyDown = function (event) {
            if (event.key === 'Escape' || event.key === 'Esc') close();
          };
          window.addEventListener('keydown', onKeyDown);
          return function () {
            window.removeEventListener('keydown', onKeyDown);
          };
        },
        [open],
      );

      /**
       * 关闭后把焦点还给入口（Esc、遮罩、关闭按钮三条路径都收敛到 setOpen(false)）。
       * 首次渲染 open=false 时不能 focus，否则页面载入就会抢走焦点——所以用 wasOpen 作门。
       */
      useEffect(
        function () {
          if (open) {
            wasOpen.current = true;
            return;
          }
          if (!wasOpen.current) return;
          wasOpen.current = false;
          var node = entryRef.current;
          if (node && typeof node.focus === 'function') node.focus();
        },
        [open],
      );

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: entryRef,
            type: 'button',
            className: 'po-entry',
            title: '植物组学 · 源与工具（静态清单）',
            'aria-label': '植物组学，打开源与工具清单',
            'aria-expanded': open ? 'true' : 'false',
            onClick: function () {
              setOpen(!open);
            },
          },
          h('span', { className: 'po-badge', 'aria-hidden': 'true' }, '植'),
          wide ? h('span', { className: 'po-label' }, '组学') : null,
        ),
        open && typeof document !== 'undefined'
          ? createPortal(h(Panel, { model: model, onClose: close }), document.body)
          : null,
      );
    }

    /**
     * 注册入口。
     *
     * 与官方/先例一致的三条：
     *   1. `exports.inject = ['slots']` 是模块级依赖，少了它 fiber 会在 slots 之前跑；
     *   2. 注册项的槽位键是 `name`；
     *   3. 注册包在 `slots.inject('<槽位>')` 里，等父级声明后再注册，否则整个 fiber 失败。
     */
    function apply(ctx) {
      var slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined);
      if (!slots || typeof slots.register !== 'function') {
        // 宿主装配问题，不是我们的配置错：留痕但不抛，避免把整个界面拖下水。
        try {
          console.warn('[plant-omics] slots 服务不可用，侧边栏入口未注册');
        } catch (error) {
          /* 忽略：没有 console 的环境里只能静默 */
        }
        return;
      }

      var mount = function () {
        var disposeStyles = insertStyles();
        var disposeSlot = slots.inject('sidebar.footer.action', function () {
          return slots.register(
            { name: 'sidebar.footer.action', id: 'plant-omics', order: 50 },
            Entry,
          );
        });
        return function () {
          try {
            if (typeof disposeSlot === 'function') disposeSlot();
          } catch (error) {
            /* 卸载期失败不再升级 */
          }
          disposeStyles();
        };
      };

      if (typeof ctx.effect === 'function') {
        ctx.effect(mount, 'plant-omics.sidebar-entry');
        return;
      }
      mount();
    }

    exports.name = 'plant-omics-client';
    exports.apply = apply;
    exports.inject = ['slots'];
    exports.buildPanelModel = buildPanelModel;
    exports.Entry = Entry;
    exports.Panel = Panel;
    exports.moduleId = MODULE_ID;
    exports.catalog = CATALOG;

    return module.exports;
  }

  var host = typeof window !== 'undefined' ? window : undefined;
  if (host && host.__ModuleLoader__ && typeof host.__ModuleLoader__.load === 'function') {
    host.__ModuleLoader__.load({ id: MODULE_ID, factory: factory });
  }
})();
