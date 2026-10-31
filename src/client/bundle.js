// dsh-plugin-plant-omics —— 浏览器半边（手写 lazy-CJS bundle，不引 bundler）
//
// 形态依据（2026-10-28 读本机已装包）：
//   - dsh 的客户端模块系统是惰性 CJS：执行本文件只做一件事——把 factory 注册到
//     window.__ModuleLoader__；真正的副作用（取 React、注册槽位、注入样式）都在
//     factory 被物化时发生（@deepseek-ai/dsh-client-modules README）。
//   - id 必须等于 Loader 条目的包名（这里是 plantomics-hub），否则 web boot
//     会报 `bundle … loaded without registering "<id>"`。构建脚本注入并断言。
//   - 平台模块表里有 react / react-dom（官方 client bundle 用 require 取），
//     所以不需要 dsh.client.external，也不新增运行时依赖。
//
// 界面按 `web/PANEL-DESIGN.md` 接线：**源列表优先**，点进去才是详情；一屏只做一件事。
// v1 是构建期快照（数据由 scripts/build-client.mjs 注入），**不显示任何运行状态**——
// 构建期快照不等于上游当前可用，也不代表本会话启用了这些工具。

(function () {
  'use strict';

  var BOOT =
    (typeof globalThis !== 'undefined' && globalThis.__PLANT_OMICS_CLIENT__) || {};
  var MODULE_ID = BOOT.moduleId || 'plantomics-hub';
  var META = {
    moduleId: MODULE_ID,
    packageVersion: BOOT.packageVersion || '未知',
    builtAt: BOOT.builtAt || '未知',
    builtAtSource: BOOT.builtAtSource || 'unknown',
    sourceRev: BOOT.sourceRev || '未知',
    webUrl: BOOT.webUrl || null,
  };
  var CATALOG = BOOT.catalog || {
    schemaVersion: 0,
    budget: { sources: 0, maxSources: 20, tools: 0, maxTools: 40 },
    pinned: [],
    sources: [],
    tools: [],
  };
  /** 源图标：构建期从 `src/client/source-icons.json` 注入（与落地页同一份符号与主色）。 */
  var ICONS = BOOT.icons || {};

  /**
   * 面板的纯数据模型。刻意与 React 分开：
   * 测试不带 DOM 就能断言「面板上写了什么」，也让「静态」这句声明有唯一出处。
   *
   * 顺序不在这里排：`buildCatalog()` 已按 `src/core/pinned-sources.json` 置顶好，
   * 面板直接用——两处各排一次迟早不一致。
   */
  function buildPanelModel(catalog, meta, icons) {
    var data = catalog || {};
    var budget = data.budget || { sources: 0, maxSources: 20, tools: 0, maxTools: 40 };
    var sources = data.sources || [];
    var tools = data.tools || [];
    var iconMap = icons || {};
    var info = meta || {};

    var toolsBySource = {};
    for (var i = 0; i < tools.length; i += 1) {
      var tool = tools[i];
      var key = tool.sourceId || '元工具';
      if (!toolsBySource[key]) toolsBySource[key] = [];
      toolsBySource[key].push({
        name: tool.name,
        whenToUse: tool.whenToUse || '',
        required: tool.required || [],
        sourceId: tool.sourceId || '元工具',
      });
    }

    var ready = sources.length > 0;
    var webUrl = typeof info.webUrl === 'string' && info.webUrl !== '' ? info.webUrl : null;

    return {
      state: ready ? 'ready' : 'empty',
      header: {
        title: 'PlantOmics Hub',
        status: ready
          ? '构建期清单 · ' + sources.length + ' 源 / ' + tools.length + ' 工具'
          : '清单未注入',
        // 数字口径写在 title 上：这是快照，不是上游此刻可用，也不是本会话已启用
        statusTitle: '数字来自构建期注册表，不代表上游此刻可用',
        snapshot: info.sourceRev ? String(info.sourceRev) : '未知',
      },
      empty: {
        title: '清单未注入',
        text: '构建脚本没有产出 client catalog，面板暂无可显示的内容',
      },
      sources: sources.map(function (source) {
        var icon = iconMap[source.id] || null;
        return {
          id: source.id,
          name: source.displayName,
          tier: source.tier,
          toolCount: source.toolCount,
          pinned: source.pinned === true,
          species: source.species || [],
          blindSpots: source.blindSpots || [],
          versionNote: source.versionNote || '未知',
          icon: icon,
          toolNames: (toolsBySource[source.id] || []).map(function (entry) {
            return entry.name;
          }),
        };
      }),
      toolsBySource: toolsBySource,
      budget: budget,
      jump: {
        label: '在试调页打开',
        url: webUrl,
        disabled: webUrl === null,
        title: webUrl === null
          ? '未配置试调页地址（构建时未提供 PLANTOMICS_WEB_URL）'
          : '在试调页打开这个源',
      },
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
      '.po-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:flex-end;',
      'padding:16px;background:rgba(0,0,0,.45)}',
      '.po-dialog{display:flex;flex-direction:column;width:min(360px,100%);max-height:min(78vh,720px);min-width:0;',
      'border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:14px;background:Canvas;',
      'color:CanvasText;box-shadow:0 18px 60px rgba(0,0,0,.35);font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.po-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px 10px;',
      'border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}',
      '.po-title{margin:0;font-size:14px;font-weight:600}',
      '.po-status{margin:4px 0 0;font-size:12px;opacity:.82}',
      '.po-snap{margin:2px 0 0;font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.po-close{border:0;border-radius:8px;background:transparent;color:inherit;font-size:18px;line-height:1;',
      'width:28px;height:28px;cursor:pointer;flex:none}',
      '.po-close:hover{background:color-mix(in srgb,currentColor 12%,transparent)}',
      '.po-body{overflow:auto;padding:12px 14px 14px;min-width:0}',
      '.po-bar{margin:0 0 10px;padding:8px 10px;border-radius:10px;font-size:12px;line-height:1.55;',
      'overflow-wrap:anywhere;border:1px solid transparent}',
      '.po-bar-warn{background:color-mix(in srgb,#c9922f 16%,transparent);',
      'border-color:color-mix(in srgb,#c9922f 40%,transparent)}',
      '.po-bar-bad{background:color-mix(in srgb,#c2402f 14%,transparent);',
      'border-color:color-mix(in srgb,#c2402f 38%,transparent)}',
      '.po-row{display:flex;align-items:center;gap:10px;width:100%;padding:8px;border:0;border-radius:10px;',
      'background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left;min-width:0}',
      '.po-row:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
      '.po-row:focus-visible{outline:2px solid color-mix(in srgb,currentColor 45%,transparent);outline-offset:2px}',
      '.po-ico{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;',
      'border-radius:8px;color:var(--src,currentColor);',
      'background:color-mix(in srgb,var(--src,currentColor) 14%,transparent);font-size:12px;opacity:1}',
      '.po-ico svg{width:18px;height:18px}',
      '.po-row-main{min-width:0;flex:1}',
      '.po-name{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.po-sub{display:block;font-size:11px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.po-tier{flex:none;font-size:10px;padding:1px 5px;border-radius:5px;',
      'border:1px solid color-mix(in srgb,currentColor 25%,transparent);opacity:.8}',
      '.po-pin{flex:none;font-size:10px;padding:1px 5px;border-radius:5px;',
      'background:color-mix(in srgb,#c2402f 18%,transparent);border:1px solid color-mix(in srgb,#c2402f 35%,transparent)}',
      '.po-back{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 0;',
      'font-size:12px;opacity:.8}',
      '.po-back:hover{opacity:1}',
      '.po-detail-h{margin:6px 0 2px;font-size:14px;font-weight:600;overflow-wrap:anywhere}',
      '.po-kv{margin:6px 0 0;font-size:12px;opacity:.8;overflow-wrap:anywhere}',
      '.po-blind{margin:8px 0 0;padding:0 0 0 16px;font-size:12px;opacity:.8}',
      '.po-blind li{margin:2px 0;overflow-wrap:anywhere}',
      '.po-tool{margin:8px 0 0;padding:8px 10px;border-radius:10px;',
      'border:1px solid color-mix(in srgb,CanvasText 12%,transparent);min-width:0}',
      '.po-tool-name{font-weight:600;font-size:12px;overflow-wrap:anywhere}',
      '.po-tool-line{margin:2px 0 0;font-size:11px;opacity:.78;overflow-wrap:anywhere}',
      '.po-jump{display:block;width:100%;margin:12px 0 0;padding:8px 10px;border-radius:10px;font:inherit;',
      'font-size:12px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);',
      'background:color-mix(in srgb,currentColor 8%,transparent);color:inherit}',
      '.po-jump[disabled]{opacity:.5;cursor:not-allowed}',
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

    /** 缺图标时用「?」占位：看得见的缺失，好过静默没有。 */
    function renderIcon(source) {
      var icon = source.icon;
      if (!icon || !icon.svg) {
        return h('span', { className: 'po-ico', 'aria-hidden': 'true' }, '?');
      }
      return h('span', {
        className: 'po-ico',
        'aria-hidden': 'true',
        style: { '--src': icon.color },
        dangerouslySetInnerHTML: {
          __html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
            + 'stroke-linecap="round" stroke-linejoin="round">' + icon.svg + '</svg>',
        },
      });
    }

    function SourceRow(props) {
      var source = props.source;
      return h(
        'button',
        {
          type: 'button',
          className: 'po-row',
          onClick: function () { props.onOpen(source.id); },
        },
        renderIcon(source),
        h(
          'span',
          { className: 'po-row-main' },
          h('span', { className: 'po-name', title: source.name }, source.name),
          h(
            'span',
            { className: 'po-sub' },
            source.toolCount + ' 个工具 · 盲区 ' + source.blindSpots.length + ' 条',
          ),
        ),
        h('span', { className: 'po-tier' }, source.tier),
        source.pinned ? h('span', { className: 'po-pin' }, '置顶') : null,
      );
    }

    function DetailView(props) {
      var source = props.source;
      var tools = props.model.toolsBySource[source.id] || [];
      var children = [
        h(
          'button',
          { type: 'button', className: 'po-back', key: 'back', onClick: props.onBack },
          '← 返回列表',
        ),
        h('h3', { className: 'po-detail-h', key: 'name' }, source.name),
        h(
          'p',
          { className: 'po-kv', key: 'kv' },
          '等级 ' + source.tier + ' · 工具 ' + source.toolCount + ' 个 · 物种 ' + (source.species.length > 0 ? source.species.join('、') : '未登记'),
        ),
        h('p', { className: 'po-kv', key: 'ver' }, '版本口径：' + source.versionNote),
      ];

      if (source.blindSpots.length > 0) {
        children.push(
          h('ul', { className: 'po-blind', key: 'blind' }, source.blindSpots.map(function (line, index) {
            return h('li', { key: 'b' + index }, line);
          })),
        );
      } else {
        children.push(h('p', { className: 'po-kv', key: 'blind-none' }, '盲区：未登记（不代表没有）'));
      }

      if (tools.length === 0) {
        children.push(h('p', { className: 'po-kv', key: 'tools-none' }, '本源的工具有：无（未注入）'));
      } else {
        children.push(h('div', { key: 'tools' }, tools.map(function (tool) {
          return h(
            'div',
            { className: 'po-tool', key: tool.name },
            h('div', { className: 'po-tool-name' }, tool.name),
            h('p', { className: 'po-tool-line' }, '何时用：' + tool.whenToUse),
            h('p', { className: 'po-tool-line' }, '必填：' + (tool.required.length > 0 ? tool.required.join(', ') : '无')),
          );
        })));
      }

      children.push(
        h(
          'button',
          {
            type: 'button',
            className: 'po-jump',
            key: 'jump',
            disabled: props.model.jump.disabled,
            title: props.model.jump.title,
            onClick: function () {
              if (props.model.jump.disabled || typeof window === 'undefined') return;
              window.open(props.model.jump.url, '_blank', 'noopener');
            },
          },
          props.model.jump.label,
        ),
      );

      return h('div', { key: 'detail' }, children);
    }

    function Panel(props) {
      var model = props.model || {};
      var header = model.header || { title: 'PlantOmics Hub', status: '', statusTitle: '', snapshot: '' };
      var closeRef = useRef(null);
      var selectedState = useState(null);
      var selectedId = selectedState[0];
      var setSelectedId = selectedState[1];

      useEffect(function () {
        if (closeRef.current && typeof closeRef.current.focus === 'function') {
          closeRef.current.focus();
        }
      }, []);

      var selected = null;
      var sources = model.sources || [];
      for (var i = 0; i < sources.length; i += 1) {
        if (sources[i].id === selectedId) selected = sources[i];
      }

      var body;
      if (model.state === 'empty') {
        body = h(
          'div',
          { key: 'empty' },
          h('div', { className: 'po-bar po-bar-warn' }, (model.empty && model.empty.title) || '清单未注入'),
          h('p', { className: 'po-kv' }, (model.empty && model.empty.text) || ''),
        );
      } else if (selected) {
        body = h(DetailView, {
          key: 'detail',
          model: model,
          source: selected,
          onBack: function () { setSelectedId(null); },
        });
      } else {
        body = h(
          'div',
          { key: 'list' },
          sources.map(function (source) {
            return h(SourceRow, {
              key: source.id,
              source: source,
              onOpen: function (id) { setSelectedId(id); },
            });
          }),
        );
      }

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
            'aria-label': header.title,
          },
          h(
            'header',
            { className: 'po-head' },
            h(
              'div',
              null,
              h('h2', { className: 'po-title' }, header.title),
              h('p', { className: 'po-status', title: header.statusTitle }, header.status),
              h('p', { className: 'po-snap', title: '构建期快照的源码版本' }, '快照 ' + header.snapshot),
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
          h('div', { className: 'po-body' }, body),
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
      var model = buildPanelModel(CATALOG, META, ICONS);

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
            title: 'PlantOmics Hub · 源与工具（构建期清单）',
            'aria-label': 'PlantOmics Hub，打开源与工具清单',
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
