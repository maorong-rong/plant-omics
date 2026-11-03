/**
 * 选源页（静态版）：勾哪些源，就看这些源会带来多少工具、多少上下文 token。
 *
 * 四条口径写在代码里，改之前先读（2026-11-03 依 `docs/catalog契约.md` v1.1 重写）：
 *
 * 1. **阈值只有一个来源：`GET /catalog` 的 `budget`**。
 *    以前这里写死 `TOOL_CAP = 80` / `TOOL_WARN = 40`，服务端调阈值页面会继续按 80/40 说话——
 *    契约 §四.3 明令禁止。现在取 `budget.subsetToolsHardMax` 与 `budget.defaultSetSoftMax`；
 *    **读不到就不猜**：数字位显示「待 /catalog」，超限判定整体停用（不红不黄、也不假装没超）。
 *
 * 2. **默认集照 `budget.defaultSources`，不是「全部源」**。
 *    全库 41 而默认 35（契约 §四.3 第 4 条）。页面若初始全选，就等于向用户谎报
 *    「默认会报警」——与服务器不带头时的真实行为相反。所以初始选中 = `defaultSources`，
 *    「全选（全库）」是另一个按钮，不是「默认」。
 *
 * 3. **全库大小取 `totals.tools`**。`budget.tools` 已从契约里取消（§三），
 *    以前 `(catalog.budget && catalog.budget.tools) || 0` 恒为 0，凡是用它的显示都是假数——
 *    假数比空值危险，因为它看起来像真的。读不到就是 `null`，显示「—」。
 *
 * 4. **本页仍不发 MCP 调用**。唯一的网络请求是 `GET /catalog`（只读、免鉴权，
 *    用来拿阈值与默认清单）；卡片、勾选、预算计算都在本地。点「连接并核对」时才会发一次 `tools/list`。
 *
 * 卡片事实（源名、工具数、盲区、物种）仍来自构建期快照 `web/data/catalog.js`：
 * 快照回答「构建那一刻源码有什么」，`/catalog` 回答「这个服务现在给你什么」，两者不混用。
 */
(function () {
  'use strict';

  var catalog = window.__PLANTOMICS_CATALOG__ || null;
  var icons = window.__PMH_SOURCE_ICONS__ || {};

  /**
   * 阈值与默认集：**只从 `/catalog` 来**。任一字段缺失就留 null，页面显示「待 /catalog」，
   * 绝不回落到字面量（回落等于把旧口径重新写死，换个地方复发）。
   */
  var limits = {
    cap: null,               // budget.subsetToolsHardMax
    warn: null,              // budget.defaultSetSoftMax
    tokensPerTool: null,     // budget.estTokensPerTool
    defaultSources: null,    // budget.defaultSources（顺序即推荐顺序）
    defaultSetTools: null,   // budget.defaultSetTools
    fullSetTools: null,      // totals.tools（全库）
    metaTools: null,         // totals.metaTools
    liveCounts: null,        // /catalog 的 sources[].toolCount（订阅集按它算，见 toolCountOf）
    loaded: false,           // /catalog 是否已经拿到 200
    error: null              // 取数失败的原因（显示用，不藏）
  };

  /** 拉丁名 → 卡片上显示的作物名。没收录的物种显示「其他」，不猜。 */
  var SPECIES_CROP = {
    'Triticum aestivum': '小麦',
    'Triticum turgidum': '小麦',
    'Aegilops tauschii': '小麦',
    'Oryza sativa': '水稻',
    'Oryza sativa Japonica Group': '水稻',
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
    crop: 'all',
    touched: false   // 用户动过勾选之后，/catalog 回来的默认集不再覆盖他的选择
  };

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function num(value) { return typeof value === 'number' && isFinite(value) ? value : null; }

  function cropsOf(source) {
    var crops = [];
    (source.species || []).forEach(function (latin) {
      var crop = SPECIES_CROP[latin] || '其他';
      if (crops.indexOf(crop) === -1) crops.push(crop);
    });
    return crops;
  }

  /** 元工具数：优先用 `/catalog` 的 totals.metaTools，其次数快照里的清单，最后 0。 */
  function metaToolCount() {
    if (limits.metaTools !== null) return limits.metaTools;
    return (catalog.metaTools || []).length;
  }

  function sourceById(id) {
    var list = (catalog && catalog.sources) || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /**
   * 一个源会带来多少工具：**能拿到 `/catalog` 的数就以它为准**。
   * 卡片上写的是构建期快照的数，订阅集算的是「你连上去以后装几个」——两者来自不同构建时会不同，
   * 混着算就会出现「页面说 35、服务端说 101」这种假冲突。快照只在拿不到实时数时兜底。
   */
  function toolCountOf(id) {
    if (limits.liveCounts && typeof limits.liveCounts[id] === 'number') return limits.liveCounts[id];
    var source = sourceById(id);
    return source ? source.toolCount : 0;
  }

  /** 快照与 `/catalog` 数字不一致的已选源——用来在页面上明说，而不是让两个数并存。 */
  function countMismatch(ids) {
    if (!limits.liveCounts) return [];
    return ids.filter(function (id) {
      var source = sourceById(id);
      return source && typeof limits.liveCounts[id] === 'number' && limits.liveCounts[id] !== source.toolCount;
    });
  }

  function totals() {
    var ids = Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
    var tools = ids.reduce(function (sum, id) { return sum + toolCountOf(id); }, 0) + metaToolCount();
    var tokens = limits.tokensPerTool === null ? null : tools * limits.tokensPerTool;
    return { ids: ids, tools: tools, tokens: tokens, mismatched: countMismatch(ids) };
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  /* ── 取 `/catalog`：阈值与默认集的唯一来源 ───────────────────────────── */
  /**
   * `?stub=` 只用于本地负控（和 `assets/market.js` 同一套约定）：
   * warn / over 让 stub 放大每源工具数，none 让 stub 不给默认清单，fail 让 stub 返回 404。
   * 线上不会带这个参数，取数路径本身仍是 `fetch('/catalog')`。
   */
  function catalogQuery() {
    var stub = new URLSearchParams(location.search).get('stub');
    if (stub === 'warn' || stub === 'over') return '?load=' + stub;
    if (stub === 'none') return '?defaults=none';
    if (stub === 'fail') return '?fail=404';
    return '';
  }

  function loadCatalog() {
    return fetch('/catalog' + catalogQuery(), { headers: { accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var budget = (data && data.budget) || {};
      var totalsBlock = (data && data.totals) || {};
      limits.cap = num(budget.subsetToolsHardMax);
      limits.warn = num(budget.defaultSetSoftMax);
      limits.tokensPerTool = num(budget.estTokensPerTool);
      limits.defaultSetTools = num(budget.defaultSetTools);
      limits.fullSetTools = num(totalsBlock.tools);
      limits.metaTools = num(totalsBlock.metaTools);
      limits.defaultSources = Array.isArray(budget.defaultSources) ? budget.defaultSources.slice() : null;
      limits.liveCounts = null;
      if (Array.isArray(data && data.sources)) {
        var live = {};
        data.sources.forEach(function (item) {
          if (item && typeof item.id === 'string' && typeof item.toolCount === 'number') live[item.id] = item.toolCount;
        });
        limits.liveCounts = live;
      }
      limits.loaded = true;
      limits.error = null;
      return data;
    }).catch(function (error) {
      limits.loaded = false;
      limits.error = String(error && error.message ? error.message : error);
      return null;
    });
  }

  /**
   * 契约 §四.3 第 4 条：`defaultSetTools` 必须等于「默认清单里各源工具数之和 + 元工具数」。
   * 页面**自己复算一遍**再比对——对不上就明说，而不是拿服务端那个数当结论。
   * 这条是给契约上的活口子：服务端改了默认清单却没同步数字，这里会先红。
   */
  function checkDefaultSet() {
    var box = $('#default-check');
    if (!box) return;
    box.hidden = true;
    box.className = 'footnote';
    box.textContent = '';

    if (!limits.loaded) {
      box.hidden = false;
      box.textContent = '默认集口径待 /catalog：取不到服务端预算，本页不猜默认清单。';
      return;
    }
    if (!limits.defaultSources) {
      box.hidden = false;
      box.className = 'footnote bad-note';
      box.textContent = '服务端这次没给 budget.defaultSources（契约 v1.1 第 4 条要求它）：默认选中态不可用，'
        + '页面不会自己编一份「默认」。全选（全库）与手动勾选照常可用。';
      return;
    }

    var unknown = limits.defaultSources.filter(function (id) { return !sourceById(id); });
    var sum = limits.defaultSources.reduce(function (acc, id) { return acc + toolCountOf(id); }, 0) + metaToolCount();
    var declared = limits.defaultSetTools;

    if (unknown.length > 0) {
      box.hidden = false;
      box.className = 'footnote bad-note';
      box.textContent = 'budget.defaultSources 里有本快照不认识的源 id：' + unknown.join('、')
        + '。默认选中只取认识的条目，并在此点名——不静默跳过。';
    }
    if (declared !== null && sum !== declared) {
      box.hidden = false;
      box.className = 'footnote bad-note';
      box.textContent = '默认集口径不一致：服务端 budget.defaultSetTools = ' + declared
        + '，但按 defaultSources 复算是 ' + sum + '（' + limits.defaultSources.length
        + ' 源工具数 + ' + metaToolCount() + ' 元工具）。契约 §四.3 第 4 条要求两者相等，'
        + '这一处要服务端修，页面不替任何一边圆场。';
    }
  }

  function applyDefaultSelection() {
    if (!limits.defaultSources || state.touched) return false;
    var next = {};
    limits.defaultSources.forEach(function (id) {
      if (sourceById(id)) next[id] = true;
    });
    state.selected = next;
    return true;
  }

  /* ── 渲染 ─────────────────────────────────────────────────────────── */
  function update() {
    var t = totals();
    var totalSources = (catalog.sources || []).length;

    $('#n-sources').textContent = String(t.ids.length) + ' / ' + totalSources;
    $('#n-tools').textContent = String(t.tools);
    $('#n-tokens').textContent = limits.tokensPerTool === null ? '待 /catalog' : '≈ ' + fmt(t.tokens);
    $('#n-cap').textContent = limits.cap === null ? '待 /catalog' : String(limits.cap);

    var bar = $('#budget-bar');
    var parent = bar.parentElement;
    if (limits.cap === null) {
      bar.style.width = '0%';
      parent.className = 'budget';
    } else {
      bar.style.width = (Math.min(1, t.tools / limits.cap) * 100).toFixed(1) + '%';
      parent.className = 'budget' + (t.tools > limits.cap ? ' over' : (limits.warn !== null && t.tools > limits.warn ? ' tight' : ''));
    }

    var warn = $('#warn');
    var kind = $('#warn-kind');
    var msg = $('#warn-msg');

    if (limits.cap === null || limits.warn === null) {
      // 阈值没拿到：不红不黄，也不假装「没超」。说清缺的是什么。
      warn.hidden = false;
      warn.className = 'banner';
      if (kind) kind.textContent = '阈值待 /catalog';
      msg.textContent = '取不到服务端阈值（budget.subsetToolsHardMax / budget.defaultSetSoftMax），'
        + '所以本页不判超限：当前勾选 ' + t.ids.length + ' 个源，含元工具共 ' + t.tools + ' 个工具'
        + '（快照与推导数字），超没超要以服务端为准。';
    } else if (t.tools > limits.cap) {
      warn.hidden = false;
      warn.className = 'banner bad';
      if (kind) kind.textContent = '超过硬上限 · 拒绝';
      msg.textContent =
        '已选 ' + t.tools + ' 个工具，超过订阅集上限 ' + limits.cap + '（多 ' + (t.tools - limits.cap) + ' 个）——这一组不能用。'
        + '后果不是「慢一点」：工具声明要全量常驻上下文'
        + (t.tokens === null ? '' : '，' + t.tools + ' 个约 ' + fmt(t.tokens) + ' token，128K 上下文吃掉 ' + Math.round((t.tokens / 128000) * 100) + '%')
        + '。可操作的做法：砍掉用不上的源（至少再减 ' + (t.tools - limits.cap) + ' 个工具），或分成两次会话各订一部分。';
    } else if (t.tools > limits.warn) {
      warn.hidden = false;
      warn.className = 'banner warn';
      if (kind) kind.textContent = '超过推荐集 · 警示';
      msg.textContent =
        '已选 ' + t.tools + ' 个工具，超过默认推荐集 ' + limits.warn + '（未超过硬上限 ' + limits.cap + '）。'
        + '仍可用，但上下文会更紧'
        + (t.tokens === null ? '' : '：约 ' + fmt(t.tokens) + ' token，32K 上下文下约占 ' + Math.round((t.tokens / 32000) * 100) + '%')
        + '。不是错，只是要知道代价。';
    } else {
      warn.hidden = true;
      if (kind) kind.textContent = '';
      msg.textContent = '';
    }

    var tokensNote = limits.tokensPerTool === null
      ? '每工具 token 估算待 /catalog（budget.estTokensPerTool）'
      : '每工具按 ' + limits.tokensPerTool + ' token 估（取 budget.estTokensPerTool）';
    var limitNote = limits.cap === null
      ? '阈值待 /catalog'
      : '阈值：> ' + limits.warn + ' 警示、> ' + limits.cap + ' 拒绝（均取 budget）';
    var mismatchNote = t.mismatched.length === 0
      ? ''
      : '其中 ' + t.mismatched.length + ' 个源的卡片数字与 /catalog 不一致（' + t.mismatched.join('、') + '），工具数按 /catalog 计、卡片按构建期快照显示。';
    $('#picked-note').textContent = 'token 估算：' + tokensNote + '；工具数含 ' + metaToolCount()
      + ' 个 hub_* 元工具。' + limitNote + '。全库当前 '
      + (limits.fullSetTools === null ? '—' : limits.fullSetTools) + ' 个工具（totals.tools）。' + mismatchNote;

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

    var defaultsBtn = $('#defaults');
    if (defaultsBtn) {
      defaultsBtn.disabled = !limits.defaultSources;
      defaultsBtn.title = limits.defaultSources
        ? '按 /catalog 的 budget.defaultSources 选中 ' + limits.defaultSources.length + ' 个源'
        : '/catalog 没给 budget.defaultSources，无法恢复默认集';
    }

    // 给审查与自动化留一个只读出口：页面此刻认的阈值与默认集，不用去猜 DOM
    window.__PMH_PICKER_STATE__ = {
      limits: {
        cap: limits.cap,
        warn: limits.warn,
        tokensPerTool: limits.tokensPerTool,
        defaultSources: limits.defaultSources,
        defaultSetTools: limits.defaultSetTools,
        fullSetTools: limits.fullSetTools,
        metaTools: limits.metaTools,
        loaded: limits.loaded,
        error: limits.error
      },
      selected: Object.keys(state.selected).filter(function (id) { return state.selected[id]; }),
      tools: t.tools,
      tokens: t.tokens
    };
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
        state.touched = true;
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
        state.touched = true;
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
        // 全库大小只认 totals.tools（契约 §三 已取消 budget.tools）；读不到就是 null，
        // 那就**不能**判「这是全集」——宁可说不知道，不能拿 0 当全集。
        var fullSetSize = limits.fullSetTools;

        if (extra.length === 0 && missing.length === 0) {
          showVerdict('ok', '服务端按子集返回，与勾选一致',
            '这次请求只装了你勾的 ' + ids.length + ' 个源；返回的工具集合与页面统计逐个对上。',
            '期望 ' + expected.length + ' 个 · 实际 ' + got.length + ' 个');
          return;
        }
        if (fullSetSize !== null && extra.length + missing.length > 0 && got.length === fullSetSize) {
          showVerdict('bad', '服务端未按子集返回（返回了全集）',
            '它返回了 ' + got.length + ' 个工具，正好是全集大小（totals.tools），而你只勾了 ' + ids.length + ' 个源。'
            + '最可能的原因：这个服务端不认 x-plantomics-sources（旧版本），或中间代理把它剥掉了。'
            + '页面不会把这次结果当作「已按选择过滤」——上面那 ' + got.length + ' 个才是你实际会看到的工具。'
            + '换支持子集的服务端，或改用 PLANTOMICS_SOURCES 启动服务。',
            '期望 ' + expected.length + ' 个 · 实际 ' + got.length + ' 个（全集 ' + fullSetSize + '）');
          return;
        }
        showVerdict('warn', '返回的工具集与勾选不一致',
          (missing.length ? '少了 ' + missing.length + ' 个（' + missing.slice(0, 5).join('、') + (missing.length > 5 ? '…' : '') + '）' : '')
          + (missing.length && extra.length ? '；' : '')
          + (extra.length ? '多了 ' + extra.length + ' 个（' + extra.slice(0, 5).join('、') + (extra.length > 5 ? '…' : '') + '）' : '')
          + (fullSetSize === null ? '。全库大小未知（totals.tools 没取到），所以不判「是否返回了全集」。' : '')
          + '。以服务端返回为准，别按页面里那张勾选表推断可用工具。',
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

    $('#snap').textContent = 'commit ' + (catalog.gitCommit || '—') +
      ' · ' + String(catalog.generatedAt || '').slice(0, 16).replace('T', ' ') + 'Z';

    $('#defaults').addEventListener('click', function () {
      state.touched = false;
      applyDefaultSelection();
      update();
    });
    $('#all').addEventListener('click', function () {
      state.touched = true;
      (catalog.sources || []).forEach(function (source) { state.selected[source.id] = true; });
      update();
    });
    $('#none').addEventListener('click', function () {
      state.touched = true;
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

    // 先按快照把卡片画出来（不需要网络），再等 `/catalog` 回阈值与默认集。
    // 默认选中**不**在渲染前做：那会在数据回来前给用户一个假的「默认」。
    renderCrops();
    renderGrid();
    update();

    loadCatalog().then(function () {
      applyDefaultSelection();
      checkDefaultSet();
      update();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
