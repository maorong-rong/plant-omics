/**
 * 选源页（静态版）：勾哪些源，就看这些源会带来多少工具、多少上下文 token。
 *
 * 三条口径都写在代码里，改之前先读：
 * 1. **数都从 `data/catalog.js` 来**（由 `site/scripts/build-data.mjs` 生成的那份快照），页面不写死任何数字。
 * 2. **工具上限 40、每工具 280 token 是口径参数**，不是估算随便写的：40 来自仓规 §十，280 是实测口径。
 * 3. **超限要说清后果**：不是「建议少选」，而是「装不下——工具全量常驻进不了上下文，需要检索层或砍源」。
 *
 * 本页**不发任何网络请求**：它是「选择器长什么样、选完会怎样」的静态版。
 */
(function () {
  'use strict';

  var TOOL_CAP = 40;        // 仓规 §十：工具总数上限（含元工具）
  /**
   * 每工具约 280 token 的**出处**（别写成「某人的口径」）：
   * 论文侧用 cl100k_base 实测「全量 tools/list」合计 10 253 token，除以 37 个工具 ≈ 277，
   * 取整到 280 作为估算基数。测量对象是整个工具声明（名字 + 描述 + inputSchema），
   * 不是单次调用结果；换 tokenizer 或改工具描述，这个数就变，所以只作估算。
   */
  var TOKENS_PER_TOOL = 280;

  var catalog = window.__PLANTOMICS_CATALOG__ || null;
  var icons = window.__PMH_SOURCE_ICONS__ || {};

  /** 拉丁名 → 卡片上显示的作物名。没收录的物种显示「其他」，不猜。 */
  var SPECIES_CROP = {
    'Triticum aestivum': '小麦',
    'Triticum turgidum': '小麦',
    'Aegilops tauschii': '小麦',
    'Oryza sativa': '水稻',
    'Oryza sativa Indica Group': '水稻',
    'Zea mays': '玉米',
    'Fragaria vesca': '草莓',
    'Fragaria × ananassa': '草莓',
    'Saccharum spontaneum': '甘蔗',
    'Arabidopsis thaliana': '拟南芥',
    'Taraxacum kok-saghyz': '橡胶蒲公英',
    'Botrytis cinerea': '病原真菌'
  };

  /** 作物筛选顺序：常见在前。 */
  var CROP_ORDER = ['小麦', '水稻', '玉米', '草莓', '甘蔗', '拟南芥', '橡胶蒲公英', '病原真菌'];

  var state = {
    selected: {},
    crop: 'all'
  };

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function cropsOf(source) {
    var crops = [];
    (source.species || []).forEach(function (latin) {
      var crop = SPECIES_CROP[latin] || '其他';
      if (crops.indexOf(crop) === -1) crops.push(crop);
    });
    return crops;
  }

  function metaToolCount() {
    return (catalog.metaTools || []).length;
  }

  function totals() {
    var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
    var tools = ids.reduce(function (sum, id) {
      var source = catalog.sources.filter(function (s) { return s.id === id; })[0];
      return sum + (source ? source.toolCount : 0);
    }, 0) + metaToolCount();
    return { ids: ids, tools: tools, tokens: tools * TOKENS_PER_TOOL };
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  function update() {
    var t = totals();
    $('#n-sources').textContent = String(t.ids.length) + ' / ' + catalog.sources.length;
    $('#n-tools').textContent = String(t.tools);
    $('#n-tokens').textContent = '≈ ' + fmt(t.tokens);
    $('#n-cap').textContent = String(TOOL_CAP);

    var bar = $('#budget-bar');
    var parent = bar.parentElement;
    var ratio = Math.min(1, t.tools / TOOL_CAP);
    bar.style.width = (ratio * 100).toFixed(1) + '%';
    parent.className = 'budget' + (t.tools > TOOL_CAP ? ' over' : (t.tools >= TOOL_CAP - 4 ? ' tight' : ''));

    var warn = $('#warn');
    if (t.tools > TOOL_CAP) {
      warn.hidden = false;
      $('#warn-msg').textContent =
        '已选 ' + t.tools + ' 个工具，超过上限 ' + TOOL_CAP + ' 个（多 ' + (t.tools - TOOL_CAP) + ' 个）。' +
        '后果不是「慢一点」而是装不下：工具声明要全量常驻上下文，超了就得先有检索层，或者少勾几个源。' +
        '当前估算 ≈ ' + fmt(t.tokens) + ' token。';
    } else {
      warn.hidden = true;
    }

    $('#picked-note').textContent =
      'token 估算：全量 tools/list 实测 10 253 ÷ 37 ≈ 277（cl100k_base，取整 280/工具）；' +
      '工具总数含 ' + metaToolCount() + ' 个 hub_* 元工具。' +
      (t.tools === TOOL_CAP ? ' 正好用满上限。' : (t.tools > TOOL_CAP - 4 && t.tools <= TOOL_CAP ? ' 接近上限，再加一个源可能就超。' : ''));

    document.querySelectorAll('.card').forEach(function (card) {
      var id = card.getAttribute('data-id');
      card.setAttribute('data-on', String(!!state.selected[id]));
      var box = card.querySelector('input[type="checkbox"]');
      if (box) box.checked = !!state.selected[id];
    });

    var copyHint = $('#copy-hint');
    if (t.ids.length === 0) copyHint.textContent = '一个都没选：复制出来是空值，等于用服务端默认全集。';
    else copyHint.textContent = '用它启动服务，只暴露这 ' + t.ids.length + ' 个源的工具。';

    $('#copy').disabled = false;
  }

  function renderCrops() {
    var box = $('#crops');
    box.innerHTML = '';
    var present = {};
    (catalog.sources || []).forEach(function (source) {
      cropsOf(source).forEach(function (crop) { present[crop] = true; });
    });
    var chips = ['all'].concat(CROP_ORDER.filter(function (crop) { return present[crop]; }));
    chips.forEach(function (crop) {
      var label = crop === 'all' ? '全部' : crop;
      var btn = el('button', null, label);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(state.crop === crop));
      btn.addEventListener('click', function () {
        state.crop = crop;
        box.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        applyFilter();
      });
      box.appendChild(btn);
    });
  }

  function applyFilter() {
    document.querySelectorAll('.card').forEach(function (card) {
      var crops = (card.getAttribute('data-crops') || '').split('|');
      var show = state.crop === 'all' || crops.indexOf(state.crop) !== -1;
      card.setAttribute('aria-hidden', String(!show));
    });
  }

  function renderGrid() {
    var grid = $('#grid');
    grid.innerHTML = '';
    (catalog.sources || []).forEach(function (source) {
      var crops = cropsOf(source);
      var meta = icons[source.id] || {};

      var card = el('article', 'card');
      card.setAttribute('data-id', source.id);
      card.setAttribute('data-crops', crops.join('|'));
      if (meta.color) card.style.setProperty('--src', meta.color);

      var head = el('div', 'card-head');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.id = 'pick-' + source.id;
      box.checked = !!state.selected[source.id];
      box.addEventListener('change', function () {
        state.selected[source.id] = box.checked;
        update();
      });
      head.appendChild(box);

      var chip = el('span', 'chip-icon');
      if (meta.color) chip.style.setProperty('--src', meta.color);
      if (meta.svg) {
        chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + meta.svg + '</svg>';
      } else {
        chip.textContent = '?';
      }
      head.appendChild(chip);

      var title = el('div', 'card-title');
      var label = document.createElement('label');
      label.setAttribute('for', box.id);
      label.appendChild(el('div', 'nm', source.label.zh.name));
      label.appendChild(el('div', 'en', source.label.en.name));
      title.appendChild(label);
      head.appendChild(title);
      card.appendChild(head);

      var cropRow = el('div', 'crops');
      crops.forEach(function (crop) { cropRow.appendChild(el('span', 'crop-tag', crop)); });
      card.appendChild(cropRow);

      var foot = el('div', 'card-foot');
      foot.appendChild(el('span', 'tools', source.toolCount + ' 个工具'));
      foot.appendChild(el('span', null, '· 盲区 ' + (source.caveats || []).length + ' 条'));
      foot.appendChild(el('span', 'tier ' + source.tier, source.tier));
      card.appendChild(foot);

      // 整卡可点：点空白处也能切换，但点是 label 时交给原生行为，避免双触发
      card.addEventListener('click', function (event) {
        if (event.target.closest('label') || event.target === box) return;
        box.checked = !box.checked;
        state.selected[source.id] = box.checked;
        update();
      });

      grid.appendChild(card);
    });
  }

  function copySelection() {
    var ids = totals().ids;
    var value = 'PLANTOMICS_SOURCES=' + ids.join(',');
    var done = function () {
      var hint = $('#copy-hint');
      hint.textContent = ids.length ? '已复制：' + value : '已复制空值（= 默认全集）';
      setTimeout(update, 1800);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done, function () { window.prompt('复制这段', value); });
    } else {
      window.prompt('复制这段', value);
    }
  }

  /* ── 接真实服务核对 ───────────────────────────────────────────────
     硬约束（群里定过）：发完 x-plantomics-sources 必须**回读本次 tools/list**。
     服务端不认这个头时会返回全集——那种情况下必须明说「未按子集返回」，
     绝不能显示「已按你的选择过滤」。悄悄忽略的头是最难查的 bug。 */
  var TOKEN_KEY = 'pmh-web-token';

  function liveToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function saveLiveToken(value) {
    try { value ? sessionStorage.setItem(TOKEN_KEY, value) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ }
  }
  function endpointUrl(value) {
    var text = String(value || '').trim() || '/mcp';
    if (/^https?:\/\//i.test(text)) return text;
    return location.origin.replace(/\/$/, '') + (text.charAt(0) === '/' ? text : '/' + text);
  }
  function expectedTools() {
    var ids = totals().ids;
    var names = [];
    (catalog.sources || []).forEach(function (source) {
      if (ids.indexOf(source.id) === -1) return;
      (source.tools || []).forEach(function (tool) { names.push(tool.name); });
    });
    (catalog.metaTools || []).forEach(function (tool) { names.push(tool.name); });
    return names;
  }

  function showVerdict(kind, title, message, numbers) {
    var box = $('#live-verdict');
    box.hidden = false;
    box.className = 'verdict ' + kind;
    box.innerHTML = '';
    var head = el('div');
    head.appendChild(el('b', null, title));
    box.appendChild(head);
    if (message) box.appendChild(el('div', null, message));
    if (numbers) box.appendChild(el('div', 'v-nums', numbers));
  }

  function showLiveTools(names) {
    var details = $('#live-tools');
    var list = $('#live-tool-list');
    list.textContent = names.join('\n');
    details.hidden = false;
    details.open = true;
  }

  function connectLive() {
    var ids = totals().ids;
    var button = $('#live-connect');
    if (ids.length === 0) {
      showVerdict('warn', '一个源都没选', '不选源等于请求默认全集：请求头会留空，服务端返回全部工具。先在卡片上勾选，再来核对。');
      return;
    }
    var token = $('#live-token').value;
    saveLiveToken(token);
    var url = endpointUrl($('#endpoint').value);
    var expected = expectedTools();

    button.disabled = true;
    showVerdict('warn', '正在核对…', '向 ' + url + ' 发 tools/list，请求头 x-plantomics-sources: ' + ids.join(','), '');

    var headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-plantomics-sources': ids.join(',') };
    if (token) headers.authorization = 'Bearer ' + token;

    fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} })
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON：下面按原文报 */ }
        if (res.status === 400) {
          var detail = json && json.detail ? json.detail : text.slice(0, 200);
          showVerdict('bad', '服务端拒绝了这次子集请求（400）', detail +
            '。这是好事：说明它在读这个头，而不是默默给你全集。');
          return;
        }
        if (res.status === 401) {
          showVerdict('bad', 'token 被拒（401）', '服务端没接受这个 token。确认与服务端 PLANTOMICS_HUB_TOKEN 一致；页面不回显 token 片段。');
          return;
        }
        if (res.status === 403) {
          showVerdict('bad', '服务端拒绝来源（403）', '部署侧要把本站域名加进 PLANTOMICS_HUB_ALLOWED_HOSTS（只写主机名）。');
          return;
        }
        if (!res.ok) {
          showVerdict('bad', '调用失败（HTTP ' + res.status + '）', text.slice(0, 200));
          return;
        }
        var tools = (json && json.result && json.result.tools) || [];
        var got = tools.map(function (t) { return t.name; });
        showLiveTools(got);

        var gotSet = {};
        got.forEach(function (n) { gotSet[n] = true; });
        var expectedSet = {};
        expected.forEach(function (n) { expectedSet[n] = true; });

        var extra = got.filter(function (n) { return !expectedSet[n]; });
        var missing = expected.filter(function (n) { return !gotSet[n]; });
        var fullSetSize = (catalog.budget && catalog.budget.tools) || 0;

        if (extra.length === 0 && missing.length === 0) {
          showVerdict('ok', '服务端按子集返回，与勾选一致',
            '这次请求只装了你勾的 ' + ids.length + ' 个源；返回的工具集合与页面统计逐个对上。',
            '期望 ' + expected.length + ' 个 · 实际 ' + got.length + ' 个');
          return;
        }
        if (extra.length + missing.length > 0 && got.length === fullSetSize) {
          showVerdict('bad', '服务端未按子集返回（返回了全集）',
            '它返回了 ' + got.length + ' 个工具，正好是全集大小，而你只勾了 ' + ids.length + ' 个源。' +
            '最可能的原因：这个服务端不认 x-plantomics-sources（旧版本），或中间代理把它剥掉了。' +
            '页面不会把这次结果当作「已按选择过滤」——上面那 37 个才是你实际会看到的工具。换支持子集的服务端，或改用 PLANTOMICS_SOURCES 启动服务。',
            '期望 ' + expected.length + ' 个 · 实际 ' + got.length + ' 个（全集 ' + fullSetSize + '）');
          return;
        }
        showVerdict('warn', '返回的工具集与勾选不一致',
          (missing.length ? '少了 ' + missing.length + ' 个（' + missing.slice(0, 5).join('、') + (missing.length > 5 ? '…' : '') + '）' : '') +
          (missing.length && extra.length ? '；' : '') +
          (extra.length ? '多了 ' + extra.length + ' 个（' + extra.slice(0, 5).join('、') + (extra.length > 5 ? '…' : '') + '）' : '') +
          '。以服务端返回为准，别按页面里那张勾选表推断可用工具。',
          '期望 ' + expected.length + ' 个 · 实际 ' + got.length + ' 个');
      });
    }).catch(function (error) {
      var msg = String(error && error.message ? error.message : error);
      if (/401/.test(msg)) showVerdict('bad', 'token 被拒（401）', '确认 token 与服务端一致。');
      else if (/403/.test(msg)) showVerdict('bad', '服务端拒绝来源（403）', '部署侧要把本站域名加进 PLANTOMICS_HUB_ALLOWED_HOSTS。');
      else showVerdict('bad', '连不上服务', '请求 ' + url + ' 失败：' + msg +
        '。浏览器里必须与 /mcp 同源（服务端不下发 CORS 头）；本地用 node web/dev-server.mjs 起同源开发服务器。');
    }).then(function () {
      button.disabled = false;
    });
  }

  function boot() {
    var theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

    if (!catalog) {
      $('#grid').innerHTML = '<p class="empty">缺构建期数据：先跑 node site/scripts/build-data.mjs 生成 web/data/catalog.js。</p>';
      return;
    }
    // 默认全选：先给一个「满配是多少」的基线，再让人往下减
    (catalog.sources || []).forEach(function (source) { state.selected[source.id] = true; });

    $('#snap').textContent = 'commit ' + (catalog.gitCommit || '—') +
      ' · ' + String(catalog.generatedAt || '').slice(0, 16).replace('T', ' ') + 'Z';
    $('#all').addEventListener('click', function () {
      (catalog.sources || []).forEach(function (source) { state.selected[source.id] = true; });
      update();
    });
    $('#none').addEventListener('click', function () {
      (catalog.sources || []).forEach(function (source) { state.selected[source.id] = false; });
      update();
    });
    $('#copy').addEventListener('click', copySelection);

    var tokenInput = $('#live-token');
    if (tokenInput) {
      tokenInput.value = liveToken();
      tokenInput.addEventListener('input', function () { saveLiveToken(tokenInput.value); });
    }
    var connectBtn = $('#live-connect');
    if (connectBtn) connectBtn.addEventListener('click', connectLive);

    renderCrops();
    renderGrid();
    update();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
