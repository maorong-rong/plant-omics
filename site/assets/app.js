/**
 * 落地页交互：语言切换、构建期数据填充、代码复制。
 *
 * 原则：页面上的**数字不写死在 HTML 里**。所有源数/工具数来自
 * site/data/catalog.js（由 site/scripts/build-data.mjs 从注册表生成）。
 * 数据缺失时页面显示提示，而不是显示一个可能过期的数字。
 */

(function () {
  'use strict';

  var catalog = window.__PLANTOMICS_CATALOG__;
  var root = document.documentElement;

  /* ── 主题（可选覆盖，仅用于截图核对/嵌入）──────────────────────────── */
  (function applyTheme() {
    var q = new URLSearchParams(window.location.search).get('theme');
    if (q === 'light' || q === 'dark') root.dataset.theme = q;
  })();

  /* ── 语言 ─────────────────────────────────────────────────────────── */
  var TITLES = {
    zh: 'PlantOmics Hub · 植物组学枢纽 — 让 AI 直接查植物组学公开数据',
    en: 'PlantOmics Hub — public plant-omics tools an AI can actually call',
  };

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

  document.getElementById('lang-toggle').addEventListener('click', function () {
    applyLang(root.lang === 'zh' ? 'en' : 'zh');
  });

  applyLang(detectLang());

  /* ── 数据缺失 ─────────────────────────────────────────────────────── */
  if (!catalog) {
    var missing = document.getElementById('data-missing');
    if (missing) missing.hidden = false;
    var grid = document.getElementById('source-grid');
    if (grid) grid.innerHTML = '';
    return;
  }

  var budget = catalog.budget || {};
  var metaTools = catalog.metaTools || [];
  var tiers = catalog.tiers || {};

  function text(zh, en) {
    var spanZh = document.createElement('span');
    spanZh.lang = 'zh';
    spanZh.textContent = zh;
    var spanEn = document.createElement('span');
    spanEn.lang = 'en';
    spanEn.textContent = en;
    return [spanZh, spanEn];
  }

  function el(tag, className, children) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  /* ── 顶部与页脚数字 ───────────────────────────────────────────────── */
  function fillStat(key, value) {
    document.querySelectorAll('[data-stat="' + key + '"]').forEach(function (node) {
      node.textContent = String(value);
    });
  }

  fillStat('sources', budget.sources);
  fillStat('maxSources', budget.maxSources);
  fillStat('tools', budget.tools);
  fillStat('maxTools', budget.maxTools);
  fillStat('t1', tiers.T1 == null ? 0 : tiers.T1);
  fillStat('t2', tiers.T2 == null ? 0 : tiers.T2);

  var stamp = catalog.generatedAt ? new Date(catalog.generatedAt) : null;
  var stampText = stamp
    ? stamp.toISOString().slice(0, 16).replace('T', ' ') + 'Z'
    : '未知';
  var commit = catalog.gitCommit ? catalog.gitCommit : '—';
  var version = (catalog.package && catalog.package.version) || '—';

  var snapMeta = document.getElementById('snapshot-meta');
  var build = catalog.build || null;
  // 两个时间要分开写：读数据的时刻（generatedAt）与产物来自哪次构建（sourceRev / builtAt）。
  var buildText = build && build.sourceRev ? 'build ' + build.sourceRev : 'build 未知';
  if (snapMeta) snapMeta.textContent = 'commit ' + commit + ' · ' + stampText + ' · ' + buildText + ' · v' + version;

  document.querySelectorAll('[data-version]').forEach(function (node) {
    node.textContent = version;
  });

  /* ── 已发布包口径（装上能拿到什么） ───────────────────────────────────
     数字来自 market/copy.json，由 market/scripts/build-copy.mjs 联网解包 npm tarball 算出；
     页面不写死，也不在浏览器里现算——没有这份数据就明说「未取数」，不猜。 */
  var published = catalog.published || null;
  function fillPublished(key, value) {
    document.querySelectorAll('[data-pub="' + key + '"]').forEach(function (node) {
      node.textContent = value;
    });
  }
  if (published) {
    fillPublished('spec', published.spec || '—');
    fillPublished('sources', published.sources);
    fillPublished('tools', published.tools);
    var missing = published.missingSources || [];
    document.querySelectorAll('[data-pub="missing"]').forEach(function (node) {
      var lang = node.getAttribute('data-pub-lang') === 'en' ? 'en' : 'zh';
      if (missing.length === 0) {
        node.textContent = lang === 'en' ? 'none' : '无';
        return;
      }
      node.textContent = missing
        .map(function (source) { return lang === 'en' ? source.nameEn : source.name; })
        .join(lang === 'en' ? ', ' : '、');
    });
  } else {
    // 没有发布口径数据就整段换掉，别留下「已发布的 — 实际包含 — 个源」这种残缺句子骗人。
    var note = document.getElementById('published-note');
    if (note) {
      note.querySelectorAll('[lang]').forEach(function (node) {
        node.textContent = node.getAttribute('lang') === 'en'
          ? 'Published-package figures not loaded (market/copy.json missing): run node market/scripts/build-copy.mjs.'
          : '发布口径未取数（缺 market/copy.json）：跑 node market/scripts/build-copy.mjs 生成。';
      });
    }
  }

  var footerSnap = document.getElementById('footer-snapshot');
  if (footerSnap) {
    footerSnap.textContent =
      '数据快照 commit ' + commit + ' · ' + stampText + ' · package ' + version +
      ' · 源 ' + budget.sources + '/' + budget.maxSources + ' · 工具 ' + budget.tools + '/' + budget.maxTools;
  }

  /* ── 源卡片 ───────────────────────────────────────────────────────── */
  var grid = document.getElementById('source-grid');
  grid.innerHTML = '';

  catalog.sources.forEach(function (source) {
    var card = el('article', 'source-card');
    if (source.pinned) card.className += ' is-pinned';

    // 每源一枚手写 SVG 图标 + 主色（site/assets/source-icons.js）。
    // 缺图标不静默：画一个带问号的占位块，一眼能看出漏了哪一条。
    var iconMeta = (window.__PMH_SOURCE_ICONS__ || {})[source.id];
    if (iconMeta) card.style.setProperty('--src', iconMeta.color);
    var iconChip = document.createElement('span');
    iconChip.className = 'src-icon';
    if (iconMeta) {
      iconChip.style.color = iconMeta.color;
      iconChip.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + iconMeta.svg + '</svg>';
      iconChip.setAttribute('role', 'img');
      iconChip.setAttribute('aria-label', source.label.zh.name);
    } else {
      iconChip.className = 'src-icon missing';
      iconChip.textContent = '?';
      iconChip.title = '缺图标：在 site/assets/source-icons.js 里补 ' + source.id;
    }

    var head = el('header');
    var h3 = el('h3', null, text(source.label.zh.name, source.label.en.name));
    var tier = el('span', 'tier ' + (source.tier === 'T1' ? 'tier-t1' : 'tier-t2'), [source.tier]);
    head.appendChild(iconChip);
    head.appendChild(h3);
    head.appendChild(tier);
    if (source.pinned) {
      var pin = el('span', 'pin-badge');
      pin.title = '置顶 / pinned';
      pin.innerHTML = '<span lang="zh">置顶</span><span lang="en">Pinned</span>';
      head.appendChild(pin);
    }
    card.appendChild(head);

    card.appendChild(el('p', 'blurb', text(source.label.zh.blurb, source.label.en.blurb)));

    var metaRow = el('p', 'meta-row');
    var toolsLabel = document.createElement('span');
    toolsLabel.textContent = String(source.toolCount);
    var toolWord = document.createElement('span');
    toolWord.lang = 'zh';
    toolWord.textContent = source.toolCount === 1 ? ' 个工具' : ' 个工具';
    var toolWordEn = document.createElement('span');
    toolWordEn.lang = 'en';
    toolWordEn.textContent = source.toolCount === 1 ? ' tool' : ' tools';
    var species = document.createElement('span');
    species.className = 'species';
    species.textContent = (source.species || []).join(' · ');
    // 物种是 manifest.species 的原文，不是「该源收的全部范围」——加标签和 tooltip，免得被读成排他清单
    if (species.textContent) species.title = '来自 manifest.species（原文），不等于该源的收录范围；收录口径见该源盲区';
    metaRow.appendChild(toolsLabel);
    metaRow.appendChild(toolWord);
    metaRow.appendChild(toolWordEn);
    if (species.textContent) {
      var speciesLabel = document.createElement('span');
      speciesLabel.className = 'species-label';
      speciesLabel.lang = 'zh';
      speciesLabel.textContent = 'manifest 物种：';
      metaRow.appendChild(speciesLabel);
      var speciesLabelEn = document.createElement('span');
      speciesLabelEn.className = 'species-label';
      speciesLabelEn.lang = 'en';
      speciesLabelEn.textContent = 'manifest species: ';
      metaRow.appendChild(speciesLabelEn);
      metaRow.appendChild(species);
    }
    card.appendChild(metaRow);

    // 工具清单
    var toolDetails = el('details');
    var toolSummary = el('summary', null, text('工具清单（' + source.toolCount + '）', 'Tools (' + source.toolCount + ')'));
    toolDetails.appendChild(toolSummary);
    var toolList = el('ul');
    (source.tools || []).forEach(function (tool) {
      var item = el('li');
      var code = document.createElement('code');
      code.textContent = tool.name;
      item.appendChild(code);
      if (tool.summary) item.title = tool.summary;
      toolList.appendChild(item);
    });
    toolDetails.appendChild(toolList);
    card.appendChild(toolDetails);

    // 盲区：原样转述 manifest.caveats
    if ((source.caveats || []).length > 0) {
      var caveatDetails = el('details');
      var caveatSummary = el('summary', null, text('盲区（' + source.caveats.length + '）', 'Blind spots (' + source.caveats.length + ')'));
      caveatDetails.appendChild(caveatSummary);
      var caveatList = el('ul', 'caveats');
      source.caveats.forEach(function (caveat) {
        var li = el('li');
        li.lang = 'zh';
        li.textContent = caveat;
        caveatList.appendChild(li);
      });
      var note = el('p', 'caveat-note');
      note.lang = 'en';
      note.textContent = 'Quoted verbatim from the source manifest (Chinese). Not translated.';
      caveatDetails.appendChild(caveatList);
      caveatDetails.appendChild(note);
      card.appendChild(caveatDetails);
    }

    grid.appendChild(card);
  });

  /* ── 元工具 ───────────────────────────────────────────────────────── */
  var metaGrid = document.getElementById('meta-grid');
  metaGrid.innerHTML = '';

  metaTools.forEach(function (tool) {
    var card = el('article', 'meta-card');
    var h4 = document.createElement('h4');
    h4.textContent = tool.name;
    card.appendChild(h4);
    card.appendChild(el('p', null, text(tool.summary, tool.label.en)));
    metaGrid.appendChild(card);
  });

  /* ── 健康检查示例（形状来自本机真实响应，数字来自注册表）───────────── */
  var healthSample = document.getElementById('healthz-sample');
  if (healthSample) {
    healthSample.textContent = JSON.stringify({
      status: 'ok',
      version: version,
      package: version,
      sources: budget.sources,
      tools: budget.tools,
      metaTools: metaTools.length,
    });
  }

  /* ── 复制按钮 ─────────────────────────────────────────────────────── */
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
})();
