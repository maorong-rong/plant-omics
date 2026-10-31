/**
 * PlantOmics Hub · 试调页
 *
 * 三条硬规矩（都是群里定过的，改动前先读）：
 * 1. **token 绝不进代码/构建产物**：只从输入框读，只放 sessionStorage；任何示例、日志、URL 都只出现 `<token>`。
 * 2. **顺序用数据给的那份**：`catalog.sources` 已经按「草莓置顶 + 其余注册表原序」排好，这里不再排一次。
 * 3. **服务不可用时是明确禁用态**：按钮 disabled + 说明为什么，绝不渲染出「看起来能调」的界面。
 *
 * 数字分两个口径：浏览页读构建期快照（离线可用），试调页一律以服务端实时返回为准；
 * 两边不一致时页面明说差在哪，不静默用旧的。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'pmh-web-token';
  var catalog = window.__PLANTOMICS_CATALOG__ || null;
  var icons = window.__PMH_SOURCE_ICONS__ || {};

  var state = {
    health: null,
    healthError: null,
    tools: null,
    toolsError: null,
    token: readToken(),
    busy: false,
    result: null
  };

  /* ── 小工具 ───────────────────────────────────────────────────────── */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function saveToken(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下 sessionStorage 可能不可用：那就只在内存里 */ }
  }

  function serviceBase() {
    // 与 /mcp 同源部署是硬前提（服务端不下发 CORS、且校验 Origin）。
    return location.origin.replace(/\/$/, '');
  }

  function showBanner(kind, title, message) {
    var box = $('#banner');
    var wrap = box.querySelector('div');
    wrap.className = '';
    box.className = 'banner ' + kind;
    box.querySelector('.kind').textContent = title;
    box.querySelector('.msg').textContent = message;
    box.hidden = false;
  }
  function hideBanner() { $('#banner').hidden = true; }

  function snapshotToolNames() {
    var names = [];
    (catalog.sources || []).forEach(function (source) {
      (source.tools || []).forEach(function (tool) { names.push({ name: tool.name, source: source.id }); });
    });
    // 元工具（hub_find_sources / hub_status）也占服务端 tools/list 的名额，漏掉它们会误报「服务端多 2 个」
    (catalog.metaTools || []).forEach(function (tool) { names.push({ name: tool.name, source: 'meta' }); });
    return names;
  }
  function toolByName(name) {
    var found = null;
    (catalog.sources || []).forEach(function (source) {
      (source.tools || []).forEach(function (tool) {
        if (tool.name === name) found = { source: source, tool: tool };
      });
    });
    return found;
  }
  function serviceTool(name) {
    if (!state.tools) return null;
    for (var i = 0; i < state.tools.length; i += 1) if (state.tools[i].name === name) return state.tools[i];
    return null;
  }
  function canCall() { return !!(state.health && state.tools); }

  /* ── 服务探测 ─────────────────────────────────────────────────────── */
  function setStatus(kind, text) {
    var node = $('#svc-status');
    node.setAttribute('data-state', kind);
    $('#svc-text').textContent = text;
  }

  function probeHealth() {
    var started = Date.now();
    return fetch(serviceBase() + '/healthz', { headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        state.health = json;
        state.healthError = null;
        setStatus('ok', '服务正常 · ' + json.sources + ' 源 / ' + json.tools + ' 工具 · ' + (Date.now() - started) + ' ms');
        compareHealth();
      })
      .catch(function (error) {
        state.health = null;
        state.healthError = String(error && error.message ? error.message : error);
        setStatus('fail', '服务未连接（' + state.healthError + '）');
        showBanner('bad', '服务未连接',
          '拿不到 ' + serviceBase() + '/healthz。按这三条查：① 服务是否在跑；② 反向代理是否把 /healthz 也转过去；' +
          '③ 页面是否与 /mcp 同源（服务端不下发 CORS 头，跨源一定失败）。下面所有「调用」按钮都已禁用。');
        render();
      });
  }

  function compareHealth() {
    if (!catalog || !state.health) return;
    var snap = catalog.budget || {};
    if (snap.sources === state.health.sources && snap.tools === state.health.tools) return;
    showBanner('warn', '数字与快照不一致',
      '页面快照是 ' + snap.sources + ' 源 / ' + snap.tools + ' 工具（构建于 ' + timeText(catalog.generatedAt) + '），' +
      '服务端现在报 ' + state.health.sources + ' 源 / ' + state.health.tools + ' 工具。' +
      '以**服务端**为准——快照只说明构建那一刻的源码状态。');
  }

  function loadTools() {
    if (!state.token) {
      state.tools = null;
      state.toolsError = 'no-token';
      return Promise.resolve();
    }
    return rpc('tools/list', {}).then(function (json) {
      if (json.error) {
        state.tools = null;
        state.toolsError = 'rpc:' + json.error.message;
        if (json.error.code === -32600 || /unauthor/i.test(json.error.message || '')) {
          showBanner('bad', 'token 被拒（401）', '服务端拒绝了这个 token。请确认它等于服务端 PLANTOMICS_HUB_TOKEN；页面不会回显 token 的任何片段。');
        }
        return;
      }
      state.tools = json.result.tools || [];
      state.toolsError = null;
      compareTools();
    }).catch(function (error) {
      state.tools = null;
      var msg = String(error && error.message ? error.message : error);
      state.toolsError = msg;
      if (/401/.test(msg)) {
        showBanner('bad', 'token 被拒（401）', '这个 token 与服务端不一致。确认后重填，页面不复述 token。');
      } else if (/403/.test(msg)) {
        showBanner('bad', '服务端拒绝来源（403）',
          '部署侧要把本站域名加进 PLANTOMICS_HUB_ALLOWED_HOSTS（只写主机名），否则浏览器带 Origin 打过去就是 403。');
      } else {
        showBanner('bad', '工具清单取不到', msg + '。试调功能已禁用。');
      }
    }).then(function () { render(); });
  }

  function compareTools() {
    if (!state.tools) return;
    var snapNames = snapshotToolNames().map(function (x) { return x.name; });
    var svcNames = state.tools.map(function (x) { return x.name; });
    var added = svcNames.filter(function (n) { return snapNames.indexOf(n) === -1; });
    var removed = snapNames.filter(function (n) { return svcNames.indexOf(n) === -1; });
    if (added.length === 0 && removed.length === 0) return;
    var parts = [];
    if (added.length) parts.push('服务端多 ' + added.length + ' 个（' + added.slice(0, 4).join('、') + (added.length > 4 ? '…' : '') + '）');
    if (removed.length) parts.push('服务端少 ' + removed.length + ' 个（' + removed.slice(0, 4).join('、') + (removed.length > 4 ? '…' : '') + '）');
    showBanner('warn', '工具清单与快照不一致',
      parts.join('；') + '。快照来自构建期，服务端才是此刻真相——按服务端的来，页面只提示不隐瞒。');
  }

  /* ── JSON-RPC ─────────────────────────────────────────────────────── */
  function rpc(method, params) {
    var headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    };
    if (state.token) headers.authorization = 'Bearer ' + state.token;
    return fetch(serviceBase() + '/mcp', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params })
    }).then(function (res) {
      if (res.status === 401) throw new Error('401 unauthorized');
      if (res.status === 403) throw new Error('403 forbidden origin');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('event-stream') !== -1) {
        return res.text().then(function (text) {
          var line = text.split(/\r?\n/).filter(function (l) { return l.indexOf('data:') === 0; }).pop();
          return JSON.parse(String(line).slice(5).trim());
        });
      }
      return res.json();
    });
  }

  /* ── 视图 ─────────────────────────────────────────────────────────── */
  function timeText(iso) {
    if (!iso) return '未知';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  }

  function hashRoute() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'tools' || parts[0] === 'try') {
      return { view: parts[0], arg: parts[1] ? decodeURIComponent(parts[1]) : null };
    }
    return { view: 'sources', arg: null };
  }

  function setNav(view) {
    ['sources', 'tools', 'try'].forEach(function (name) {
      var node = document.getElementById('nav-' + name);
      if (!node) return;
      if (name === view) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
  }

  function render() {
    var route = hashRoute();
    setNav(route.view);
    var view = $('#view');
    clear(view);
    if (!catalog) {
      view.appendChild(el('p', 'empty',
        '缺构建期快照（web/data/catalog.js）。在仓库根跑 node site/scripts/build-data.mjs 生成后再打开。'));
      return;
    }
    if (route.view === 'sources') renderSources(view, route.arg);
    else if (route.view === 'tools') renderToolDetail(view, route.arg);
    else renderTry(view, route.arg);
  }

  /* ① 浏览源 */
  function renderSources(view, selectedId) {
    var layout = el('div', 'split');

    var left = el('div', 'panel');
    left.appendChild(el('h2', null, '源（' + catalog.sources.length + '）'));
    var filter = document.createElement('input');
    filter.type = 'text';
    filter.placeholder = '过滤：源名 / 物种 / 工具名';
    filter.style.width = '100%';
    filter.style.marginBottom = '10px';
    left.appendChild(filter);

    var list = el('div', 'list');
    left.appendChild(list);

    var right = el('div', 'panel');
    layout.appendChild(left);
    layout.appendChild(right);
    view.appendChild(layout);

    var active = selectedId || (catalog.sources[0] && catalog.sources[0].id);

    function paint(filterText) {
      clear(list);
      var q = String(filterText || '').toLowerCase();
      var shown = (catalog.sources || []).filter(function (source) {
        if (!q) return true;
        var hay = [source.label.zh.name, source.label.en.name, (source.species || []).join(' '),
          (source.tools || []).map(function (t) { return t.name; }).join(' ')].join(' ').toLowerCase();
        return hay.indexOf(q) !== -1;
      });
      if (shown.length === 0) {
        list.appendChild(el('p', 'empty', '没有匹配的源'));
        return;
      }
      shown.forEach(function (source) {
        var item = document.createElement('a');
        item.className = 'item';
        item.href = '#/sources/' + source.id;
        item.setAttribute('aria-current', source.id === active ? 'true' : 'false');
        var meta = icons[source.id] || {};
        var chip = el('span', 'chip-icon');
        if (meta.color) chip.style.setProperty('--src', meta.color);
        if (meta.svg) {
          chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
            'stroke-linecap="round" stroke-linejoin="round">' + meta.svg + '</svg>';
        } else {
          chip.textContent = '?';
        }
        var text = el('span');
        text.appendChild(el('div', 'name', source.label.zh.name));
        text.appendChild(el('div', 'sub', source.toolCount + ' 个工具 · 盲区 ' + (source.caveats || []).length + ' 条'));
        var tier = el('span', 'tier ' + source.tier, source.tier);
        item.appendChild(chip);
        item.appendChild(text);
        item.appendChild(tier);
        item.addEventListener('click', function (event) {
          event.preventDefault();
          active = source.id;
          history.replaceState(null, '', '#/sources/' + source.id);
          paint(filter.value);
          renderSourceDetail(right, source);
        });
        list.appendChild(item);
      });
    }

    filter.addEventListener('input', function () { paint(filter.value); });
    paint('');

    var first = (catalog.sources || []).filter(function (s) { return s.id === active; })[0] || catalog.sources[0];
    if (first) renderSourceDetail(right, first);
  }

  function renderSourceDetail(panel, source) {
    clear(panel);
    var head = el('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '10px';
    var meta = icons[source.id] || {};
    var chip = el('span', 'chip-icon');
    if (meta.color) chip.style.setProperty('--src', meta.color);
    if (meta.svg) chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + meta.svg + '</svg>';
    var title = el('div');
    title.appendChild(el('h1', 'page', source.label.zh.name));
    title.appendChild(el('p', 'meta', null, ''));
    head.appendChild(chip);
    head.appendChild(title);
    panel.appendChild(head);

    var metaLine = title.querySelector('.meta');
    metaLine.textContent = source.tier + ' · ' + source.toolCount + ' 个工具 · ' + (source.species || []).join(' · ');

    panel.appendChild(el('p', 'blurb', source.label.zh.blurb));

    var serviceCount = 0;
    if (state.tools) {
      serviceCount = (source.tools || []).filter(function (t) { return !!serviceTool(t.name); }).length;
    }
    function literalCompare() {
      if (!state.tools) return '工具清单来自构建期快照；连上服务后可与服务端实时清单对比。';
      return '快照 ' + source.toolCount + ' 个工具，服务端此刻认得 ' + serviceCount + ' 个' +
        (serviceCount === source.toolCount ? '（一致）' : '（不一致，以服务端为准）');
    }
    panel.appendChild(el('p', 'meta', null, literalCompare()));

    var toolsBox = el('div', 'tool-list');
    (source.tools || []).forEach(function (tool) {
      var row = document.createElement('a');
      row.className = 'tool';
      row.href = '#/tools/' + tool.name;
      var left = el('div');
      left.style.minWidth = '0';
      left.appendChild(el('div', 'tname', tool.name));
      left.appendChild(el('div', 'tdesc', tool.summary || ''));
      row.appendChild(left);
      row.appendChild(el('span', 'go', '详情 →'));
      toolsBox.appendChild(row);
    });
    panel.appendChild(toolsBox);

    if ((source.caveats || []).length > 0) {
      var details = document.createElement('details');
      details.style.marginTop = '14px';
      details.appendChild(el('summary', null, '盲区（原文，' + source.caveats.length + ' 条）'));
      var ul = document.createElement('ul');
      ul.style.margin = '8px 0 0';
      ul.style.paddingLeft = '18px';
      ul.style.fontSize = '13px';
      ul.style.color = 'var(--ink-2)';
      source.caveats.forEach(function (text) { ul.appendChild(el('li', null, text)); });
      details.appendChild(ul);
      panel.appendChild(details);
    }
  }

  /* ② 工具详情 */
  function renderToolDetail(view, name) {
    var panel = el('div', 'panel');
    view.appendChild(panel);
    if (!name) {
      panel.appendChild(el('p', 'empty', '从「浏览源」里选一个工具，或直接打开 #/tools/<工具名>。'));
      return;
    }
    var found = toolByName(name);
    var live = serviceTool(name);
    if (!found && !live) {
      panel.appendChild(el('p', 'empty', '快照与服务端都没有工具 ' + name + '。'));
      return;
    }
    panel.appendChild(el('h1', 'page', name));
    var source = found ? found.source : null;
    panel.appendChild(el('p', 'meta', null,
      (source ? source.label.zh.name + ' · ' + source.tier : '仅服务端可见') +
      (live ? ' · 服务端已确认存在' : (state.tools ? ' · 服务端清单里没有它（可能已改名）' : ' · 未连接服务，未确认'))));

    panel.appendChild(el('p', 'blurb', (live && live.description) || (found && found.tool.summary) || '（无描述）'));

    var schema = live && live.inputSchema;
    if (schema && schema.properties) {
      panel.appendChild(el('h2', null, '参数'));
      panel.appendChild(renderParamsTable(schema));
    } else {
      panel.appendChild(el('p', 'meta', null,
        '参数表需要服务端的 inputSchema 才能生成；现在' + (state.token ? '连不上或未取到清单' : '没有 token，只显示快照里的工具名与描述') + '。'));
    }

    var actions = el('p');
    actions.style.marginTop = '16px';
    var goTry = document.createElement('a');
    goTry.href = '#/try/' + name;
    goTry.className = 'btn';
    goTry.innerHTML = '<button class="primary" type="button"' + (canCall() ? '' : ' disabled') + '>去试调 →</button>';
    goTry.addEventListener('click', function (e) { if (!canCall()) e.preventDefault(); });
    actions.appendChild(goTry);
    if (!canCall()) {
      actions.appendChild(el('span', 'meta', null, ' 服务未连接或未授权，调用已禁用。'));
    }
    panel.appendChild(actions);
  }

  function renderParamsTable(schema) {
    var table = el('table', 'params');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['参数', '类型', '必填', '说明'].forEach(function (label) { hr.appendChild(el('th', null, label)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var required = schema.required || [];
    Object.keys(schema.properties).forEach(function (key) {
      var prop = schema.properties[key] || {};
      var tr = document.createElement('tr');
      var nameCell = document.createElement('td');
      nameCell.appendChild(el('code', null, key));
      tr.appendChild(nameCell);
      tr.appendChild(el('td', null, prop.type || 'any'));
      var reqCell = el('td', 'req');
      reqCell.appendChild(el('span', required.indexOf(key) !== -1 ? 'req-yes' : 'req-no',
        required.indexOf(key) !== -1 ? '必填' : '可选'));
      tr.appendChild(reqCell);
      tr.appendChild(el('td', null, prop.description || ''));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /* ③ 试调 */
  var DEFAULT_TOOL = 'wheatomics_search_known_genes';

  function allToolNames() {
    var names = [];
    (catalog.sources || []).forEach(function (source) {
      (source.tools || []).forEach(function (tool) { names.push(tool.name); });
    });
    return names;
  }

  function renderTry(view, name) {
    var names = allToolNames();
    var toolName = name || (names.indexOf(DEFAULT_TOOL) !== -1 ? DEFAULT_TOOL : names[0]) || null;
    if (!toolName) {
      view.appendChild(el('p', 'empty', '快照里没有任何工具。'));
      return;
    }

    var headBar = el('div');
    headBar.style.marginBottom = '12px';
    var found = toolByName(toolName);
    headBar.appendChild(el('h1', 'page', '试调 · ' + toolName));
    var metaLine = el('p', 'meta');
    if (found) {
      metaLine.appendChild(document.createTextNode(found.source.label.zh.name + ' · ' + found.source.tier + ' · '));
      var detail = document.createElement('a');
      detail.href = '#/tools/' + toolName;
      detail.textContent = '看工具详情';
      metaLine.appendChild(detail);
    } else {
      metaLine.textContent = '快照里没有这个工具名（可能来自服务端新版本）。';
    }
    headBar.appendChild(metaLine);

    var picker = document.createElement('select');
    picker.setAttribute('aria-label', '切换工具');
    names.forEach(function (toolNameOption) {
      var option = document.createElement('option');
      option.value = toolNameOption;
      option.textContent = toolNameOption;
      if (toolNameOption === toolName) option.selected = true;
      picker.appendChild(option);
    });
    picker.addEventListener('change', function () { location.hash = '#/try/' + picker.value; });
    picker.style.marginBottom = '12px';
    headBar.appendChild(picker);
    view.appendChild(headBar);

    var layout = el('div', 'split three');

    var paramsPanel = el('div', 'panel');
    paramsPanel.appendChild(el('h2', null, '参数'));
    var formHost = el('div');
    paramsPanel.appendChild(formHost);
    var callBtn = document.createElement('button');
    callBtn.className = 'primary';
    callBtn.type = 'button';
    callBtn.textContent = '发起调用';
    callBtn.style.marginTop = '6px';
    paramsPanel.appendChild(callBtn);
    paramsPanel.appendChild(el('p', 'meta', null, canCall()
      ? '调用会真的打到 ' + serviceBase() + '/mcp（Bearer 只在请求头里出现）。'
      : '服务未连接或未授权：调用按钮已禁用。'));

    var requestPanel = el('div', 'panel');
    requestPanel.appendChild(el('h2', null, '请求预览'));
    var preview = el('pre', 'code');
    requestPanel.appendChild(preview);

    var resultPanel = el('div', 'panel');
    resultPanel.appendChild(el('h2', null, '结果'));
    var status = el('div', 'result-status', '尚未调用');
    var reason = '';
    if (!state.healthError && !state.health) reason = '正在检测服务…';
    else if (state.healthError) reason = '连不上 ' + serviceBase() + '/healthz（' + state.healthError + '）。';
    else if (!state.token) reason = '还没有填 token：右上角填好后点「连接」。';
    else if (state.toolsError) reason = '工具清单没取到（' + (state.toolsError === 'no-token' ? '缺少 token' : state.toolsError) + '）。';
    else if (!canCall()) reason = '服务不可用，调用已禁用。';
    var body = el('div', 'result-body', canCall()
      ? '填好参数后点「发起调用」。'
      : '当前不能调用：' + reason);
    var prov = el('div', 'prov');
    prov.hidden = true;
    resultPanel.appendChild(status);
    resultPanel.appendChild(body);
    resultPanel.appendChild(prov);

    layout.appendChild(paramsPanel);
    layout.appendChild(requestPanel);
    layout.appendChild(resultPanel);
    view.appendChild(layout);

    var live = serviceTool(toolName);
    var schema = live && live.inputSchema;
    var inputs = {};

    function buildForm() {
      clear(formHost);
      inputs = {};
      if (!schema || !schema.properties) {
        formHost.appendChild(el('p', 'empty',
          '没有服务端 inputSchema，无法生成表单。' + (state.token ? '先点右上「连接」取一次工具清单。' : '先在右上填 token 并连接。')));
        preview.textContent = 'POST ' + serviceBase() + '/mcp\n' +
          'content-type: application/json\n' +
          'authorization: Bearer <token>\n\n' +
          JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: toolName, arguments: {} }
          }, null, 2) + '\n\n// 参数按服务端 inputSchema 生成；连上服务后这里会变成带真实字段的请求';
        return;
      }
      var required = schema.required || [];
      Object.keys(schema.properties).forEach(function (key) {
        var prop = schema.properties[key] || {};
        var field = el('div', 'field');
        var label = document.createElement('label');
        label.textContent = key;
        label.setAttribute('for', 'p-' + key);
        field.appendChild(label);
        var input;
        if (prop.type === 'integer' || prop.type === 'number') {
          input = document.createElement('input');
          input.type = 'number';
          if (prop.minimum != null) input.min = String(prop.minimum);
          if (prop.maximum != null) input.max = String(prop.maximum);
          input.step = prop.type === 'integer' ? '1' : 'any';
          if (prop.default != null) input.value = String(prop.default);
        } else if (prop.type === 'boolean') {
          input = document.createElement('select');
          ['false', 'true'].forEach(function (v) { input.appendChild(new Option(v, v)); });
        } else if (prop.type === 'object' || prop.type === 'array') {
          input = document.createElement('textarea');
          input.rows = 3;
          input.placeholder = 'JSON（' + prop.type + '）';
        } else {
          input = document.createElement('input');
          input.type = 'text';
          if (prop.default != null) input.value = String(prop.default);
        }
        input.id = 'p-' + key;
        input.disabled = !canCall();
        field.appendChild(input);
        field.appendChild(el('div', 'hint' + (required.indexOf(key) !== -1 ? ' required' : ''),
          (required.indexOf(key) !== -1 ? '必填' : '可选') + (prop.description ? ' · ' + prop.description : '')));
        inputs[key] = { input: input, prop: prop, required: required.indexOf(key) !== -1, key: key };
        formHost.appendChild(field);
      });
      updatePreview();
    }

    function readArgs() {
      var args = {};
      Object.keys(inputs).forEach(function (key) {
        var entry = inputs[key];
        var raw = entry.input.value;
        if (raw === '') return;
        if (entry.prop.type === 'integer' || entry.prop.type === 'number') args[key] = Number(raw);
        else if (entry.prop.type === 'boolean') args[key] = raw === 'true';
        else if (entry.prop.type === 'object' || entry.prop.type === 'array') {
          try { args[key] = JSON.parse(raw); } catch (e) { args[key] = raw; }
        } else args[key] = raw;
      });
      return args;
    }

    function updatePreview() {
      preview.textContent = 'POST ' + serviceBase() + '/mcp\n' +
        'content-type: application/json\n' +
        'authorization: Bearer <token>\n\n' +
        JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: toolName, arguments: readArgs() }
        }, null, 2);
    }

    formHost.addEventListener('input', updatePreview);

    callBtn.disabled = !canCall();
    if (!canCall()) {
      callBtn.textContent = '发起调用（服务未就绪）';
      callBtn.title = reason || '服务不可用';
    }
    callBtn.addEventListener('click', function () {
      if (!canCall()) return;
      var args = readArgs();
      var missing = Object.keys(inputs).filter(function (k) { return inputs[k].required && args[k] === undefined; });
      if (missing.length) {
        status.className = 'result-status err';
        status.textContent = '缺必填参数';
        body.textContent = '还差：' + missing.join('、');
        prov.hidden = true;
        return;
      }
      state.busy = true;
      callBtn.disabled = true;
      status.className = 'result-status wait';
      status.textContent = '调用中…';
      body.textContent = '等待 ' + serviceBase() + '/mcp 响应';
      prov.hidden = true;
      var started = Date.now();

      rpc('tools/call', { name: toolName, arguments: args }).then(function (json) {
        var ms = Date.now() - started;
        if (json.error) {
          status.className = 'result-status err';
          status.textContent = 'JSON-RPC 报错 · ' + ms + ' ms';
          body.textContent = JSON.stringify(json.error, null, 2);
          return;
        }
        var result = json.result || {};
        var text = (result.content || []).map(function (part) {
          return part.type === 'text' ? part.text : '[' + part.type + ']';
        }).join('\n');
        if (result.isError) {
          status.className = 'result-status err';
          status.textContent = '工具报错（isError）· ' + ms + ' ms';
          body.textContent = text || '（工具没有返回正文）';
          return;
        }
        status.className = 'result-status ok';
        status.textContent = '200 · ' + ms + ' ms · ' + (text.length ? text.length + ' 字符' : '空结果');
        // 出处尾注单独高亮：以「——」开头的尾段
        var idx = text.lastIndexOf('\n——');
        if (idx !== -1) {
          body.textContent = text.slice(0, idx).trim();
          prov.hidden = false;
          prov.textContent = '出处（原样）：\n' + text.slice(idx + 1).trim();
        } else {
          body.textContent = text;
          prov.hidden = true;
        }
      }).catch(function (error) {
        var ms = Date.now() - started;
        status.className = 'result-status err';
        status.textContent = '调用失败 · ' + ms + ' ms';
        var msg = String(error && error.message ? error.message : error);
        if (/401/.test(msg)) body.textContent = 'token 被拒（401）。确认与服务端 PLANTOMICS_HUB_TOKEN 一致。';
        else if (/403/.test(msg)) body.textContent = '服务端拒绝来源（403）：部署侧要把本站域名加入 PLANTOMICS_HUB_ALLOWED_HOSTS。';
        else body.textContent = '连不上服务：' + msg + '\n目标：' + serviceBase() + '/mcp';
      }).then(function () {
        state.busy = false;
        callBtn.disabled = !canCall();
      });
    });

    buildForm();
  }

  /* ── 启动 ─────────────────────────────────────────────────────────── */
  function boot() {
    // 主题覆盖只给截图核对与嵌入用，界面上不放开关（与落地页同一口径）
    var theme = new URLSearchParams(location.search).get('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

    if (catalog) {
      $('#foot-snap').textContent = 'commit ' + (catalog.gitCommit || '—') +
        ' · ' + timeText(catalog.generatedAt) +
        (catalog.build && catalog.build.sourceRev ? ' · build ' + catalog.build.sourceRev : '');
    }
    var tokenInput = $('#token');
    if (state.token) tokenInput.value = state.token;
    tokenInput.addEventListener('input', function () {
      state.token = tokenInput.value;
      saveToken(state.token);
      state.tools = null;
      state.toolsError = null;
      if (canCall()) render();
      else { loadTools().then(render); }
    });

    $('#connect').addEventListener('click', function () {
      state.token = tokenInput.value;
      saveToken(state.token);
      hideBanner();
      probeHealth().then(loadTools).then(render);
    });

    // 清除 token：真的清 sessionStorage、真的回到「未认证 = 调用禁用」的态。
    // sessionStorage 的语义：同一标签页刷新仍保留；关闭标签页通常会清除，但浏览器恢复会话时可能保留。
    // 所以「关掉标签页」不能当作能保证的清除方式——确定性只挂在下面这个按钮上。
    $('#clear-token').addEventListener('click', function () {
      state.token = '';
      state.tools = null;
      state.toolsError = 'no-token';
      saveToken('');
      tokenInput.value = '';
      hideBanner();
      setStatus(state.health ? 'warn' : 'fail',
        state.health ? '已清除 token · 未认证（服务仍在线）' : '已清除 token · 服务未连接');
      render();
    });

    window.addEventListener('hashchange', render);
    render();
    probeHealth().then(function () { return loadTools(); }).then(render);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
