/**
 * 源市场页（`site/market.html`）：从 `GET /catalog` 取实时清单，按源订阅，实时算订阅集成本。
 *
 * 位置：原为 `web/market.js`（设计稿），2026-11-02 按群内决定迁入 `site/`；`web/` 不再留副本，
 * 唯一引用方是 `site/market.html`，与落地页共用 `assets/style.css` 的配色变量。
 *
 * 四条硬规矩（改之前先读）：
 * 1. **零硬编码数字**：源数、工具数、token、数据时刻全部来自 `/catalog` 或由它推算；
 *    接口没上线就显示「待 /catalog」，**绝不**拿 `site/data/catalog.json` 的构建期快照顶上。
 * 2. **每个数字位标来源**：实时（绿标）/ 推算（灰标，写清公式）/ 待取（黄标）。
 * 3. **阈值按仓规 v2.3**：订阅集 > 40 警示（软建议）、> 80 拒绝（硬上限），拒绝时给可操作理由。
 * 4. **不含任何凭据**：本页没有 token 输入，也不发起 MCP 调用。
 *
 * 取数只有一条路：真实 `fetch('/catalog')`。没有注入通道，也没有「读不到就退回构建期快照」的降级——
 * 快照回答的是「构建那一刻源码有什么」，不是「这个服务现在能给你什么」。
 */
(function () {
  'use strict';

  // 阈值默认值只在 `/catalog` 没给的时候兜底；拿到响应后以 `budget.*` 为准
  // ——「阈值只有一个来源」是冻结契约第 1 条，页面不许自己写死 40/80。
  var WARN_AT = 40;   // 默认推荐集软建议（budget.defaultSetSoftMax）
  var CAP_AT = 80;    // 订阅集硬上限（budget.subsetToolsHardMax）
  var TOKENS_PER_TOOL = 280; // 每工具 token（budget.estTokensPerTool）

  var state = {
    catalog: null,
    source: 'pending',
    fetchedAt: null,
    selected: {},
    // 三个阈值字段各自来自哪里：true = /catalog 给了，false = 用了本地兜底默认值。
    // 逐字段判，不整体判——线上更可能是「缺一个字段」而不是「整块 budget 都没有」。
    budgetFields: { soft: false, hard: false, tokens: false }
  };

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  /** 每个数字位配一个来源标签；kind: live / derived / pending */
  function tag(kind, text) {
    var node = el('span', 'src-tag ' + (kind === 'live' ? 'live' : kind === 'pending' ? 'pending' : ''), text);
    return node;
  }

  function setTag(id, kind, text) {
    var host = document.getElementById(id);
    if (!host) return;
    host.className = 'src-tag ' + (kind === 'live' ? 'live' : kind === 'pending' ? 'pending' : '');
    host.textContent = text;
  }

  /* ── 取数 ─────────────────────────────────────────────────────────── */
  /**
   * 只走真实 `fetch('/catalog')`。**没有注入通道、也不回落到构建期快照**：
   * 注入能验渲染但验不了取数；快照是「构建那一刻」的数字，冒充活数据就是错。
   * 同源相对路径意味着：把 base 换成 https://datamcp.moilab.net 时渲染逻辑一行不用改。
   */
  function loadCatalog() {
    // `?stub=header|none|ok|warn|over|fail` 只用于本地 stub 验证时间/阈值/失败分支；
    // 线上不会带这个参数，取数路径本身不变（仍是 fetch('/catalog')）。
    var stub = new URLSearchParams(location.search).get('stub');
    var query = '';
    if (stub === 'header' || stub === 'none' || stub === 'ok') query = '?time=' + stub;
    else if (stub === 'warn' || stub === 'over') query = '?load=' + stub;
    else if (stub === 'fail') query = '?fail=404';

    return fetch('/catalog' + query, { headers: { accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var servedAt = res.headers.get('date');
      return res.json().then(function (data) {
        return { data: data, source: 'live', servedAt: servedAt };
      });
    });
  }

  function timeText(value) {
    if (!value) return null;
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  }

  /**
   * 「数据时刻」只能来自响应本身，缺了就说缺。
   * 优先级：generatedAt（数据生成）→ fetchedAt（服务端取数）→ 响应头 Date（传输时间）。
   * **绝不用浏览器时钟兜底**——那是伪造，而且会把来源标成「来自 /catalog」，等于给假时间盖章。
   */
  function resolveStamp(data, servedAt) {
    var generated = timeText(data && data.generatedAt);
    if (generated) return { text: generated, kind: 'ok', label: '来自 /catalog' };
    var fetched = timeText(data && data.fetchedAt);
    if (fetched) return { text: fetched, kind: 'ok', label: '来自 /catalog' };
    var served = timeText(servedAt);
    if (served) return { text: served, kind: 'warn', label: '响应时间，非数据生成时间' };
    return { text: null, kind: 'warn', label: '响应里没有时间字段' };
  }

  function boot() {
    var theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

    // 用 stub 时在页面顶部明说，别让截图被当成线上数据
    if (new URLSearchParams(location.search).get('stub')) {
      var note = $('#stub-note');
      if (note) note.hidden = false;
    }

    var startBtn = $('#start');
    if (startBtn) startBtn.addEventListener('click', goStart);

    loadCatalog().then(function (result) {
      state.catalog = result.data;
      state.source = 'live';
      // 阈值与 token 估算以 `/catalog` 的 budget 为准（契约第 1 条：只有一个来源）
      var budget = result.data.budget || {};
      if (typeof budget.defaultSetSoftMax === 'number') { WARN_AT = budget.defaultSetSoftMax; state.budgetFields.soft = true; }
      if (typeof budget.subsetToolsHardMax === 'number') { CAP_AT = budget.subsetToolsHardMax; state.budgetFields.hard = true; }
      if (typeof budget.estTokensPerTool === 'number') { TOKENS_PER_TOOL = budget.estTokensPerTool; state.budgetFields.tokens = true; }
      if (typeof budget.defaultSetOverSoftMax === 'boolean') state.defaultSetOverSoftMax = budget.defaultSetOverSoftMax;
      state.stamp = resolveStamp(result.data, result.servedAt);
      setStatus(state.stamp.kind, '数据时刻：' + (state.stamp.text ? state.stamp.text + '（' + state.stamp.label + '）' : '未知'));
      // 200 之后**绝不许回退骨架**：字段形状不对就单独报 schema 问题，页面仍按已拿到的数据渲染。
      if (!Array.isArray(result.data.sources)) {
        showSchemaIssue(new Error('sources 不是数组（实际是 ' + typeof result.data.sources + '）'), 0);
        renderGrid();
        update();
        return;
      }
      // 默认不选：订阅集是用户自己的决定，不替人选
      state.catalog.sources.forEach(function (s) { state.selected[s.id] = false; });
      try {
        renderGrid();
      } catch (error) {
        showSchemaIssue(error, state.catalog.sources.length);
      }
      update();
    }).catch(function (error) {
      // 只有「取数失败」才进 pending；200 的解析/渲染错误在上面单独处理
      state.catalog = null;
      setStatus('pending', '数据时刻：待 /catalog');
      renderPending(error);
      update();
    });
  }

  /**
   * schema 错误单独报：**不许伪装成「GET /catalog 未就绪」**。
   * 字段一漂就显示「服务没上线」，看板会把「契约变了」误判成「后端没做」，这是拿错误信息骗自己。
   */
  function showSchemaIssue(error, renderedSources) {
    var box = $('#schema-note');
    if (!box) return;
    box.hidden = false;
    box.textContent = '响应 200，但字段与契约不符：' + (error && error.message ? error.message : String(error)) +
      '。已按容错规则渲染' + (renderedSources ? '（' + renderedSources + ' 个源）' : '') + '；请核对 /catalog 契约，不要当成服务未上线。';
  }

  function setStatus(kind, text) {
    var node = $('#data-status');
    node.setAttribute('data-state', kind === 'ok' ? 'ok' : 'warn');
    $('#data-text').textContent = text;
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────── */
  function iconFor(id) {
    var icons = window.__PMH_SOURCE_ICONS__ || {};
    return icons[id] || null;
  }

  /**
   * 覆盖范围：契约写 `coverage`，历史上有人写 `species`，类型还可能是 string 或数组。
   * 仓规 §三 的顺序是「上游改字段先当可选字段接住」——所以两种名字、两种类型都读；
   * 都没有就照契约文档写「未登记覆盖范围」，**不留空、也不许写成「支持全部物种」**。
   */
  function coverageList(source) {
    var raw = source.coverage != null ? source.coverage : source.species;
    if (raw == null) return [];
    if (Array.isArray(raw)) {
      return raw.map(function (item) { return String(item).trim(); }).filter(Boolean);
    }
    if (typeof raw === 'string') {
      return raw.split(/[;；,，、]/).map(function (item) { return item.trim(); }).filter(Boolean);
    }
    return [];
  }

  function cropTags(source) {
    var box = el('div', 'crops');
    var list = coverageList(source);
    if (list.length === 0) {
      box.appendChild(el('span', 'crop-tag muted', '未登记覆盖范围'));
      return box;
    }
    list.forEach(function (label) { box.appendChild(el('span', 'crop-tag', label)); });
    return box;
  }

  function renderGrid() {
    var grid = $('#grid');
    grid.innerHTML = '';
    var sources = Array.isArray(state.catalog.sources) ? state.catalog.sources : null;
    if (!sources) {
      // 形状不对：留在本页并说明字段问题，不回退 pending 骨架（那会被误读成服务没上线）
      grid.appendChild(el('p', 'mk-state',
        '响应 200，但 sources 不是数组（实际是 ' + typeof state.catalog.sources + '）。数据没被丢掉，只是无法按契约渲染——请看上方红色说明。'));
      return;
    }
    if (sources.length === 0) {
      grid.appendChild(el('p', 'mk-state full', '/catalog 返回了 0 个源——这不是正常状态，别当成「没有数据源」展示。'));
      return;
    }
    sources.forEach(function (s) {
      var card = el('article', 'mk-card');
      card.setAttribute('data-id', s.id);
      var meta = iconFor(s.id);
      if (meta && meta.color) card.style.setProperty('--src', meta.color);

      var head = el('div', 'mk-head');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.id = 'sub-' + s.id;
      box.checked = !!state.selected[s.id];
      box.addEventListener('change', function () {
        state.selected[s.id] = box.checked;
        update();
      });
      head.appendChild(box);

      var chip = el('span', 'chip-icon');
      if (meta && meta.color) chip.style.setProperty('--src', meta.color);
      if (meta && meta.svg) {
        chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + meta.svg + '</svg>';
      } else {
        chip.textContent = '?';
      }
      head.appendChild(chip);

      var title = el('div');
      title.style.minWidth = '0';
      var label = document.createElement('label');
      label.setAttribute('for', box.id);
      label.appendChild(el('div', 'nm', s.name || s.id));
      if (s.nameEn) label.appendChild(el('div', 'en', s.nameEn));
      title.appendChild(label);
      head.appendChild(title);
      if (s.tier) head.appendChild(el('span', 'tier ' + s.tier, s.tier));
      card.appendChild(head);

      var nums = el('div', 'mk-nums');
      // 每个指标「数字 + 来源标」绑成一组，不许标签掉到下一行——掉行后读起来像两个不同来源
      var toolGroup = el('span');
      toolGroup.style.whiteSpace = 'nowrap';
      toolGroup.appendChild(el('span', null, '工具 '));
      toolGroup.appendChild(el('b', null, s.toolCount == null ? '—' : String(s.toolCount)));
      toolGroup.appendChild(tag(s.toolCount == null ? 'pending' : 'live', s.toolCount == null ? '待 /catalog' : '/catalog'));
      nums.appendChild(toolGroup);

      // 盲区：契约里是 `sources[].blindSpots` + `blindSpotsTotal`。有就显示，没有整组不出现。
      // **截断必须说出来**：total > 已返回条数时写「另有 N 条」，不许静默只显示前几条。
      var blindList = Array.isArray(s.blindSpots) ? s.blindSpots : (Array.isArray(s.caveats) ? s.caveats : null);
      var blindTotal = typeof s.blindSpotsTotal === 'number' ? s.blindSpotsTotal : (blindList ? blindList.length : 0);
      if (blindList) {
        var blindGroup = el('span');
        blindGroup.style.whiteSpace = 'nowrap';
        blindGroup.appendChild(el('span', null, '· 盲区 '));
        blindGroup.appendChild(el('b', null, String(blindTotal)));
        if (blindTotal > blindList.length) {
          blindGroup.appendChild(el('span', 'crop-tag muted', '另有 ' + (blindTotal - blindList.length) + ' 条'));
        }
        blindGroup.appendChild(tag('live', '/catalog'));
        nums.appendChild(blindGroup);
      }
      card.appendChild(nums);

      card.appendChild(cropTags(s));

      if (blindList && blindList.length > 0) {
        var details = document.createElement('details');
        details.className = 'mk-blind';
        details.appendChild(el('summary', null, '盲区原文（' + blindList.length + (blindTotal > blindList.length ? ' / 共 ' + blindTotal : '') + '）'));
        var ul = document.createElement('ul');
        blindList.forEach(function (text) { ul.appendChild(el('li', null, text)); });
        details.appendChild(ul);
        if (blindTotal > blindList.length) {
          details.appendChild(el('p', 'mk-truncated', '另有 ' + (blindTotal - blindList.length) + ' 条未返回（共 ' + blindTotal + ' 条），完整清单以上游登记为准。'));
        }
        card.appendChild(details);
      }

      card.addEventListener('click', function (event) {
        if (event.target.closest('label') || event.target === box || event.target.closest('details')) return;
        box.checked = !box.checked;
        state.selected[s.id] = box.checked;
        update();
      });

      grid.appendChild(card);
    });
  }

  /** 接口未上线：只画布局骨架，所有数字位写「待 /catalog」，一个数都不编 */
  function renderPending(error) {
    var grid = $('#grid');
    grid.innerHTML = '';
    grid.appendChild(el('p', 'mk-state full',
      'GET /catalog 未就绪（' + String(error && error.message ? error.message : error) +
      '）。下面是布局骨架：卡片字段与订阅集计数条的位置可评审，但没有任何数字——接口上线后由实时数据填充。'));
    for (var i = 0; i < 3; i += 1) {
      var card = el('article', 'mk-card');
      var head = el('div', 'mk-head');
      var chip = el('span', 'chip-icon');
      chip.textContent = '?';
      head.appendChild(chip);
      head.appendChild(el('div', 'nm', '源名称（待 /catalog）'));
      card.appendChild(head);
      var nums = el('div', 'mk-nums');
      nums.appendChild(el('span', null, '工具 —'));
      nums.appendChild(tag('pending', '待 /catalog'));
      nums.appendChild(el('span', null, ' · 盲区 —'));
      card.appendChild(nums);
      card.appendChild(el('div', 'crops', '覆盖范围（待 /catalog）'));
      grid.appendChild(card);
    }
  }

  /* ── 订阅集成本 ───────────────────────────────────────────────────── */
  function totals() {
    if (!state.catalog) return { sources: null, tools: null, tokens: null };
    var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
    // 元工具数：契约放在 totals.metaTools；旧形状（顶层 metaTools 数组）也认，两种都读不到就当 0。
    var totalsBlock = state.catalog.totals || {};
    var metaTools = typeof totalsBlock.metaTools === 'number'
      ? totalsBlock.metaTools
      : ((state.catalog.metaTools && state.catalog.metaTools.length) || 0);
    var tools = ids.reduce(function (sum, id) {
      var source = (state.catalog.sources || []).filter(function (s) { return s.id === id; })[0];
      return sum + (source && typeof source.toolCount === 'number' ? source.toolCount : 0);
    }, 0);
    if (ids.length > 0) tools += metaTools;
    return { sources: ids.length, tools: tools, tokens: tools * TOKENS_PER_TOOL };
  }

  function update() {
    var t = totals();
    var pending = !state.catalog;

    $('#v-sources').textContent = pending ? '—' : String(t.sources);
    // 阈值也来自 /catalog（budget），所以它的来源标跟数据走，不写死「仓规」
    $('#v-warn').textContent = pending ? '—' : String(WARN_AT);
    $('#v-cap').textContent = pending ? '—' : String(CAP_AT);
    // 阈值来源逐字段标注：/catalog 没给的，标「默认值（/catalog 未给）」并挂 title。
    // **真值配假来源**是最危险的一类错（和「数据时刻伪造」同源），所以宁可标黄也不冒充。
    function fieldTag(id, kind, text, title) {
      setTag(id, kind, text);
      var node = document.getElementById(id);
      if (node) node.title = title || '';
    }
    if (pending) {
      fieldTag('t-warn', 'pending', '待 /catalog');
      fieldTag('t-cap', 'pending', '待 /catalog');
    } else {
      fieldTag('t-warn', state.budgetFields.soft ? 'live' : 'pending',
        state.budgetFields.soft ? '来自 /catalog' : '默认值（/catalog 未给）',
        state.budgetFields.soft ? '响应 budget.defaultSetSoftMax' : '/catalog 响应里没有 defaultSetSoftMax，此处用仓规默认值 40，不是 /catalog 给的');
      fieldTag('t-cap', state.budgetFields.hard ? 'live' : 'pending',
        state.budgetFields.hard ? '来自 /catalog' : '默认值（/catalog 未给）',
        state.budgetFields.hard ? '响应 budget.subsetToolsHardMax' : '/catalog 响应里没有 subsetToolsHardMax，此处用仓规默认值 80，不是 /catalog 给的');
    }
    $('#v-tools').textContent = pending ? '—' : String(t.tools);
    $('#v-tokens').textContent = pending ? '—' : '≈ ' + fmt(t.tokens);
    setTag('t-sources', pending ? 'pending' : 'live', pending ? '待 /catalog' : '/catalog');
    setTag('t-tools', pending ? 'pending' : 'live', pending ? '待 /catalog' : '/catalog');
    fieldTag('t-tokens', pending ? 'pending' : 'derived',
      pending ? '待 /catalog' : ('推算 · 工具数 × ' + TOKENS_PER_TOOL + (state.budgetFields.tokens ? '' : '（默认值，/catalog 未给）')),
      state.budgetFields.tokens ? '响应 budget.estTokensPerTool' : '/catalog 响应里没有 estTokensPerTool，此处用仓规默认值 280，不是 /catalog 给的');

    var fill = $('#subbar-fill');
    var bar = fill.parentElement;
    var ratio = pending ? 0 : Math.min(1, t.tools / CAP_AT);
    fill.style.width = (ratio * 100).toFixed(1) + '%';
    bar.className = 'subbar-bar' + (pending ? '' : t.tools > CAP_AT ? ' over' : t.tools > WARN_AT ? ' warn' : '');

    var verdict = $('#verdict');
    var startBtn = $('#start');
    var startHint = $('#start-hint');
    if (pending) {
      verdict.hidden = true;
      $('#subbar-note').textContent = '接口未就绪：订阅集计数不可用，数字位一律显示「待 /catalog」。';
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.title = '订阅集未知（待 /catalog），不能开始';
        if (startHint) startHint.textContent = '接口未就绪：先等 GET /catalog。';
      }
      return;
    }
    if (t.tools > CAP_AT) {
      verdict.hidden = false;
      verdict.className = 'verdict bad';
      verdict.innerHTML = '<b>超过硬上限 ' + CAP_AT + '，这一组不能用</b>' +
        '<ul>' +
        '<li>你选了 ' + t.tools + ' 个工具，约 <b>' + fmt(t.tokens) + ' token</b>；128K 上下文吃掉约 ' + Math.round(t.tokens / 128000 * 100) + '%。</li>' +
        '<li>可操作：砍掉用不上的源，至少再减 <b>' + (t.tools - CAP_AT) + '</b> 个工具；或拆成两次会话，各订一部分。</li>' +
        '</ul>';
      $('#subbar-note').textContent = '已拒绝：订阅集超过 ' + CAP_AT + ' 个工具。';
    } else if (t.tools > WARN_AT) {
      verdict.hidden = false;
      verdict.className = 'verdict warn';
      verdict.innerHTML = '<b>超过默认推荐集 ' + WARN_AT + '（仍可用）</b>' +
        '<ul><li>约 ' + fmt(t.tokens) + ' token；32K 上下文下约占 ' + Math.round(t.tokens / 32000 * 100) + '%，会明显挤压对话空间。</li>' +
        '<li>工具越多，模型选错源的概率上升（该曲线未实测，属已知风险）。</li></ul>';
      $('#subbar-note').textContent = '警示：超过推荐集 ' + WARN_AT + '，未超过硬上限 ' + CAP_AT + '。';
    } else {
      verdict.hidden = true;
      $('#subbar-note').textContent = t.sources === 0
        ? '还没选源。订阅集 = 你勾选的源的工具之和（含元工具）。'
        : '订阅集：' + t.sources + ' 个源、' + t.tools + ' 个工具，约 ' + fmt(t.tokens) + ' token。';
    }

    // 「开始使用」：拒绝态必须真的禁用（稿 §5 的承诺，不能只靠文字说「不能用」）。
    if (startBtn) {
      if (t.tools > CAP_AT) {
        startBtn.disabled = true;
        startBtn.title = '超出硬上限 ' + CAP_AT + '，还差 ' + (t.tools - CAP_AT) + ' 个工具';
        if (startHint) startHint.textContent = '被拒绝：先减掉 ' + (t.tools - CAP_AT) + ' 个工具，或拆成两次会话。';
      } else if (t.sources === 0) {
        startBtn.disabled = true;
        startBtn.title = '还没选源';
        if (startHint) startHint.textContent = '先选源；超过 ' + CAP_AT + ' 个工具时这个按钮会被禁用。';
      } else {
        startBtn.disabled = false;
        startBtn.title = '复制订阅集参数：?sources=' + Object.keys(state.selected).filter(function (id) { return state.selected[id]; }).join(',');
        if (startHint) startHint.textContent = '会复制 ?sources=…（源 id 不是凭据）；试调页尚未随本站发布，上线后拼在地址后即可。';
      }
    }
  }

  /**
   * 「开始使用」不再跳转。
   * 原地址是 `web/index.html`（试调页，开发稿，没在 `site/` 里）；搬进 `site/` 后
   * 跳 `index.html` 会落到落地页、跳 `web/…` 是死链——两种都是把按钮做成假动作。
   * 所以这里只把订阅集参数复制出来，并明说试调页还没发布；等试调页真正搬进 `site/` 再改回跳转。
   */
  function goStart() {
    var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
    if (ids.length === 0) return;
    var query = '?sources=' + encodeURIComponent(ids.join(','));
    var hint = $('#start-hint');
    copyText(query).then(function (ok) {
      if (hint) hint.textContent = (ok ? '已复制订阅集参数：' : '订阅集参数（复制失败，请手动选取）：') + query;
    });
  }

  /** 复制：优先 Clipboard API；不可用时退回隐藏 textarea + execCommand（http/file 下也能用）。 */
  function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(function () { return true; }, function () { return legacyCopy(value); });
    }
    return Promise.resolve(legacyCopy(value));
  }

  function legacyCopy(value) {
    try {
      var area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (error) {
      return false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
