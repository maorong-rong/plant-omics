/**
 * 落地页交互：语言切换、运行时取数、复制按钮。
 *
 * 三条硬规矩（2026-11-03 起，FE-07 / FE-09）：
 *
 * 1. **会漂的东西一个都不许进快照**。源清单、能力标签、数据时刻全部运行时向 `GET /catalog` 取；
 *    本文件**不读** `site/data/catalog.js`，也不含任何源数/工具数/源 id 字面量。
 *    静态文件只剩 `data/copy.js`（人工写的源名、发布口径、包版本）与图标。
 *
 * 2. **取不到就说取不到**。404 / 超时 / 非 JSON / 网络失败各有各的文案，页面上没有任何数字，
 *    **绝不**拿构建期快照顶上——「旧数字冒充现状」是这页最严重的错误。
 *
 * 3. **按契约 v1.2 渲染给人看的字段**：`displayName` / `services`（引用顶层 `servicesCatalog` 的 key）/
 *    `species`（中文常用名）。`toolCount` / `coverage` / `blindSpots` / `tools` 虽然还在响应里，
 *    页面一个字都不展示，也**不**在缺字段时拿它们兜底。
 */

(function () {
  'use strict';

  var root = document.documentElement;
  var copyData = window.__PMH_COPY__ || null;
  var icons = window.__PMH_SOURCE_ICONS__ || {};
  /**
   * 取数地址默认 `/catalog`（同源）。`?catalog=` 只用于本地与审查的**负控**：
   * 指向一个 404 路径、一个非 JSON 资源，或一个不响应的地址，验三种降级。
   * 线上不会带这个参数；带不带它，走的都是同一段 `fetch` 与同一套分支。
   */
  var CATALOG_URL = (function () {
    var override = new URLSearchParams(window.location.search).get('catalog');
    return override && override.trim() ? override.trim() : '/catalog';
  })();
  var TIMEOUT_MS = 8000;

  var TITLES = {
    zh: 'PlantOmics Hub · 植物组学枢纽 — 让 AI 直接查植物组学公开数据',
    en: 'PlantOmics Hub — public plant-omics tools an AI can actually call',
  };

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, children) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    var list = Array.isArray(children) ? children : (children == null ? [] : [children]);
    list.forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }
  function text(zh, en) {
    var zhSpan = document.createElement('span');
    zhSpan.lang = 'zh';
    zhSpan.textContent = zh;
    var enSpan = document.createElement('span');
    enSpan.lang = 'en';
    enSpan.textContent = en;
    return [zhSpan, enSpan];
  }

  /* ── 主题（仅截图核对与嵌入用） ─────────────────────────────────────── */
  (function applyTheme() {
    var q = new URLSearchParams(window.location.search).get('theme');
    if (q === 'light' || q === 'dark') root.dataset.theme = q;
  })();

  /* ── 语言 ─────────────────────────────────────────────────────────── */
  function detectLang() {
    var q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'en' || q === 'zh') return q;
    try {
      var saved = window.localStorage.getItem('pmh-lang');
      if (saved === 'en' || saved === 'zh') return saved;
    } catch (e) { /* 隐私模式：忽略 */ }
    return 'zh';
  }

  function applyLang(lang) {
    root.lang = lang;
    document.title = TITLES[lang] || TITLES.zh;
    var label = document.querySelector('.lang-toggle-label');
    if (label) label.textContent = lang === 'zh' ? 'EN' : '中文';
    var toggle = document.getElementById('lang-toggle');
    if (toggle) toggle.setAttribute('aria-label', lang === 'zh' ? 'Switch to English' : '切换到中文');
    try { window.localStorage.setItem('pmh-lang', lang); } catch (e) { /* 忽略 */ }
  }

  var langToggle = document.getElementById('lang-toggle');
  if (langToggle) {
    langToggle.addEventListener('click', function () { applyLang(root.lang === 'zh' ? 'en' : 'zh'); });
  }
  applyLang(detectLang());

  /* ── 静态文案（copy.js）：人工写的名字与发布口径，不参与「现在有几个源」 ── */
  function fillCopy() {
    if (!copyData) return;
    var published = copyData.published || null;
    var spec = document.getElementById('published-note');
    if (published) {
      document.querySelectorAll('[data-pub="spec"]').forEach(function (node) { node.textContent = published.spec || '—'; });
      document.querySelectorAll('[data-pub="missing"]').forEach(function (node) {
        var lang = node.getAttribute('data-pub-lang') === 'en' ? 'en' : 'zh';
        var missing = published.missingSources || [];
        if (missing.length === 0) { node.textContent = lang === 'en' ? 'none' : '无'; return; }
        node.textContent = missing.map(function (source) { return lang === 'en' ? (source.nameEn || source.name) : source.name; }).join(lang === 'en' ? ', ' : '、');
      });
    } else if (spec) {
      spec.querySelectorAll('[lang]').forEach(function (node) {
        node.textContent = node.lang === 'en'
          ? 'Published-package figures not loaded (data/copy.js missing): run node site/scripts/build-data.mjs.'
          : '发布口径未取数（缺 data/copy.js）：跑 node site/scripts/build-data.mjs 生成。';
      });
    }
    document.querySelectorAll('[data-install-spec]').forEach(function (node) {
      node.textContent = (published && published.spec) || 'plantomics-hub';
    });
    var version = (copyData.package && copyData.package.version) || '—';
    document.querySelectorAll('[data-version]').forEach(function (node) { node.textContent = version; });
  }

  /* ── 状态机：唯一允许写「数据暂不可用」的地方 ───────────────────────── */
  function setState(kind, message) {
    var box = $('#data-state');
    var node = $('#data-state-text');
    var retry = $('#data-retry');
    if (!box || !node) return;
    box.setAttribute('data-state', kind);
    node.innerHTML = '';
    node.appendChild(document.createTextNode(message || ''));
    if (retry) retry.hidden = kind !== 'error' && kind !== 'no-service';
  }

  /**
   * 把失败翻译成人话，且**每一种都点到具体原因**（这是审查要核的三种降级）：
   * - http-404：接口没提供（旧版本或未部署）
   * - timeout：8 秒没响应
   * - bad-json：不是 JSON（多半是代理/网关的 HTML 错误页）
   * - http-error：其它非 2xx
   * - network：请求根本没发出去（离线 / 同源没配）
   */
  function describeFailure(kind, detail) {
    switch (kind) {
      case 'http-404':
        return '接口未提供：GET /catalog 返回 404。这个部署版本还没有该接口，页面不使用任何构建期快照顶替。';
      case 'timeout':
        return '请求超时：GET /catalog ' + Math.round(TIMEOUT_MS / 1000) + ' 秒内没有响应。服务可能在启动或网络不通。';
      case 'bad-json':
        return '响应格式异常：GET /catalog 返回的不是 JSON（' + detail + '），多半是网关或反向代理的错误页。';
      case 'http-error':
        return '服务返回错误：GET /catalog ' + detail + '。';
      case 'no-service':
        return '服务信息暂不可用：这一次响应里没有 servicesCatalog / displayName / services / species，页面不拿 name、coverage、blindSpots 或工具名去猜能力。';
      default:
        return '请求失败：GET /catalog 没有成功（' + detail + '）。';
    }
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────── */
  function renderCapabilities(catalog, services) {
    var box = $('#cap-chips');
    if (!box) return;
    box.innerHTML = '';
    if (!services || services.length === 0) {
      box.appendChild(el('span', 'cap-pending', '服务信息暂不可用'));
      return;
    }
    services.forEach(function (service) {
      var chip = el('span', 'cap-chip', service.label);
      if (service.hint) chip.title = service.hint;
      chip.setAttribute('data-key', service.key);
      box.appendChild(chip);
    });
  }

  function servicesById(catalog) {
    var map = {};
    (catalog.servicesCatalog || []).forEach(function (item) { map[item.key] = item; });
    return map;
  }

  function renderSources(catalog) {
    var grid = $('#source-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var dict = servicesById(catalog);
    var sources = Array.isArray(catalog.sources) ? catalog.sources : [];

    sources.forEach(function (source) {
      var card = el('article', 'source-card');
      var iconMeta = icons[source.id];
      if (iconMeta) card.style.setProperty('--src', iconMeta.color);

      var head = el('header');
      var chip = document.createElement('span');
      chip.className = 'src-icon';
      if (iconMeta && iconMeta.svg) {
        chip.style.color = iconMeta.color;
        chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + iconMeta.svg + '</svg>';
      } else {
        chip.className = 'src-icon missing';
        chip.textContent = '?';
      }
      head.appendChild(chip);
      var h3 = el('h3', null, [source.displayName || '（未命名数据源）']);
      head.appendChild(h3);
      card.appendChild(head);

      var svcRow = el('div', 'svc-row');
      var keys = Array.isArray(source.services) ? source.services : [];
      if (keys.length === 0) {
        svcRow.appendChild(el('span', 'svc-tag muted', '服务信息暂不可用'));
      } else {
        keys.forEach(function (key) {
          var entry = dict[key];
          var tag = el('span', 'svc-tag', entry ? entry.label : key);
          if (entry && entry.hint) tag.title = entry.hint;
          svcRow.appendChild(tag);
        });
      }
      card.appendChild(svcRow);

      var species = Array.isArray(source.species) ? source.species : [];
      if (species.length > 0) {
        var spRow = el('div', 'sp-row');
        species.forEach(function (name) { spRow.appendChild(el('span', 'sp-tag', name)); });
        card.appendChild(spRow);
      }

      grid.appendChild(card);
    });

    if (sources.length === 0) {
      grid.appendChild(el('p', 'card-missing', '这次响应里没有数据源清单——服务可能在初始化，稍后重试。'));
    }
  }

  function renderMeta(catalog) {
    var grid = document.getElementById('meta-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var labels = (copyData && copyData.metaLabels) || {};
    var count = (catalog.totals && typeof catalog.totals.metaTools === 'number') ? catalog.totals.metaTools : null;

    // 只讲「能做什么」，不点内部工具名、不报数量（契约 v1.2：页面不展示工具名与工具数）
    // 固定两句人话：不带内部工具名、不带数量、不引用注册表里的技术描述
    // （注册表描述里会提到 blindSpots 这类内部概念，按契约 v1.2 不该出现在这个页面上）。
    var texts = [
      { zh: '按研究意图找到合适的数据源：不知道该问哪个库时，先问它。', en: 'Find the source that fits a research question — ask this when you do not know which database to query.' },
      { zh: '查看当前服务里有什么：有哪些源、各自覆盖什么、单次订阅的硬上限是多少。', en: 'Show what the service carries: sources, their coverage, and the hard cap for one subscription.' }
    ];
    texts.forEach(function (entry) {
      var card = el('article', 'meta-card');
      card.appendChild(el('p', null, text(entry.zh, entry.en)));
      grid.appendChild(card);
    });
    if (count !== null) grid.setAttribute('data-meta-count', String(count));
  }

  function renderCatalog(catalog) {
    var services = Array.isArray(catalog.servicesCatalog) ? catalog.servicesCatalog : null;
    var sources = Array.isArray(catalog.sources) ? catalog.sources : [];
    var hasServiceInfo = Boolean(services) && sources.every(function (source) {
      return typeof source.displayName === 'string' && Array.isArray(source.services) && Array.isArray(source.species);
    });

    renderCapabilities(catalog, services);
    renderMeta(catalog);

    var stamp = catalog.generatedAt ? new Date(catalog.generatedAt) : null;
    var stampText = stamp && !isNaN(stamp.getTime())
      ? stamp.toISOString().slice(0, 16).replace('T', ' ') + 'Z'
      : '未知';
    var version = catalog.version || '未知';
    var meta = $('#snapshot-meta');
    if (meta) meta.textContent = stampText + ' · 服务 ' + version;

    var footer = document.getElementById('footer-snapshot');
    if (footer) footer.textContent = '数据时刻 ' + stampText + '（取自 /catalog；不是本页构建时间）';

    var limitCap = document.querySelectorAll('[data-limit="cap"]');
    var limitWarn = document.querySelectorAll('[data-limit="warn"]');
    var budget = catalog.budget || {};
    limitCap.forEach(function (node) { node.textContent = typeof budget.subsetToolsHardMax === 'number' ? String(budget.subsetToolsHardMax) : '—'; });
    limitWarn.forEach(function (node) { node.textContent = typeof budget.defaultSetSoftMax === 'number' ? String(budget.defaultSetSoftMax) : '—'; });

    if (!hasServiceInfo) {
      var grid = $('#source-grid');
      if (grid) {
        grid.innerHTML = '';
        grid.appendChild(el('p', 'card-missing',
          '服务信息暂不可用：这次响应还没有给人看的字段（servicesCatalog / displayName / services / species）。' +
          '页面不会用 name、coverage、blindSpots 或工具名去猜一个能力列表——那些是内部字段，不是用户能看懂的能力。'));
      }
      setState('no-service', describeFailure('no-service'));
      return;
    }

    renderSources(catalog);
    setState('ok', '已从 /catalog 取到源清单与能力（数据时刻见下方）。');
  }

  /* ── 取数 ─────────────────────────────────────────────────────────── */
  function fetchCatalog() {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

    return fetch(CATALOG_URL, { headers: { accept: 'application/json' }, signal: controller.signal })
      .then(function (res) {
        if (res.status === 404) {
          var notFound = new Error('404');
          notFound.kind = 'http-404';
          throw notFound;
        }
        if (!res.ok) {
          var bad = new Error('HTTP ' + res.status);
          bad.kind = 'http-error';
          bad.detail = 'HTTP ' + res.status;
          throw bad;
        }
        var type = res.headers.get('content-type') || '';
        return res.text().then(function (body) {
          var parsed = null;
          try { parsed = JSON.parse(body); } catch (e) { /* 下面按格式错误报 */ }
          if (!parsed || typeof parsed !== 'object') {
            var badJson = new Error('not json');
            badJson.kind = 'bad-json';
            badJson.detail = type ? 'content-type: ' + type : '没有 content-type';
            throw badJson;
          }
          return parsed;
        });
      })
      .then(function (catalog) {
        window.clearTimeout(timer);
        return catalog;
      })
      .catch(function (error) {
        window.clearTimeout(timer);
        if (error && error.name === 'AbortError') {
          var timeout = new Error('timeout');
          timeout.kind = 'timeout';
          throw timeout;
        }
        if (!error.kind) error.kind = 'network';
        throw error;
      });
  }

  function load() {
    setState('loading', '正在向 GET /catalog 取源清单与能力…');
    var grid = $('#source-grid');
    if (grid) grid.innerHTML = '<p class="loading">正在读取服务信息…</p>';

    fetchCatalog().then(function (catalog) {
      renderCatalog(catalog);
    }).catch(function (error) {
      var kind = error.kind || 'network';
      var message = describeFailure(kind, error.detail || error.message || '');
      setState(kind === 'no-service' ? 'no-service' : 'error', message);
      if (grid) grid.innerHTML = '';
      var meta = $('#snapshot-meta');
      if (meta) meta.textContent = '数据暂不可用';
      var footer = document.getElementById('footer-snapshot');
      if (footer) footer.textContent = '数据时刻不可用（/catalog 未取到）';
      var capChips = $('#cap-chips');
      if (capChips) capChips.innerHTML = '<span class="cap-pending">数据暂不可用</span>';
      var metaGrid = document.getElementById('meta-grid');
      if (metaGrid) metaGrid.innerHTML = '';
      document.querySelectorAll('[data-limit="cap"], [data-limit="warn"]').forEach(function (node) { node.textContent = '—'; });
    });
  }

  var retry = document.getElementById('data-retry');
  if (retry) retry.addEventListener('click', load);

  /* ── 复制按钮（与数据无关，保持可用） ───────────────────────────────── */
  function copyText(value, button) {
    var done = function () {
      button.classList.add('copied');
      var zh = button.querySelector('[lang="zh"]');
      var en = button.querySelector('[lang="en"]');
      var oldZh = zh ? zh.textContent : '';
      var oldEn = en ? en.textContent : '';
      if (zh) zh.textContent = '已复制';
      if (en) en.textContent = 'Copied';
      window.setTimeout(function () {
        button.classList.remove('copied');
        if (zh) zh.textContent = oldZh;
        if (en) en.textContent = oldEn;
      }, 1400);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done, function () {});
      return;
    }
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* 忽略 */ }
    document.body.removeChild(area);
  }

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var block = button.closest('[data-code]');
      var code = block ? block.querySelector('code') : null;
      if (code) copyText(code.textContent, button);
    });
  });

  fillCopy();
  load();
})();
