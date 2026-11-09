"use strict";

// The activity page: one EventSource on /api/stream. Its first event is a full snapshot (also after every
// reconnect); later events add calls, live output and notices. Details of a finished call are fetched on demand.
(() => {
  const TOOLS = {
    open_workspace: "打开工作区",
    read: "读取",
    write: "写入",
    edit: "编辑",
    grep: "搜索内容",
    glob: "查找文件",
    bash: "执行命令",
  };
  const STATUS = { running: "进行中", ok: "完成", error: "出错", cancelled: "已中止" };
  const STATUS_TITLE = { cancelled: "客户端取消了这次调用，或者连接断开了" };
  const UNDELIVERED = "客户端取消了调用或者断开了，结果没有送到；操作本身已经完成";

  const $ = (id) => document.getElementById(id);
  const els = {
    connection: $("connection"),
    running: $("running"),
    runningCount: $("running-count"),
    runningEmpty: $("running-empty"),
    history: $("history"),
    historyCount: $("history-count"),
    historyEmpty: $("history-empty"),
    filterTool: $("filter-tool"),
    filterErrors: $("filter-errors"),
    filterText: $("filter-text"),
    client: $("client"),
    lastRequest: $("last-request"),
    uptime: $("uptime"),
    mcpUrl: $("mcp-url"),
    roots: $("roots"),
    notices: $("notices"),
    noticesEmpty: $("notices-empty"),
  };

  const state = {
    server: undefined,
    startedAt: undefined,
    lastRequestAt: undefined,
    client: undefined,
    calls: new Map(),
    live: new Map(),
    // What the server keeps; the snapshot says.
    limits: { calls: 500, notices: 200 },
  };
  /** Finished calls, by id: <details> rows in the history list. */
  const rows = new Map();
  /** Running calls, by id: cards in the "running" panel. */
  const cards = new Map();
  const filters = { tool: "", errorsOnly: false, text: "" };

  // ---- DOM and formatting helpers. Text always goes in through textContent, never as HTML.

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;

      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }

    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false || child === "") continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    return el;
  }

  const pad = (n) => String(n).padStart(2, "0");

  function clock(ms) {
    const d = new Date(ms);

    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function duration(ms) {
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

    const s = Math.floor(ms / 1000);

    if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;

    return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));

    if (s < 5) return "刚刚";
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;

    return `${Math.floor(s / 86_400)} 天前`;
  }

  function span(ms) {
    const m = Math.floor(ms / 60_000);

    if (m < 1) return "不到 1 分钟";
    if (m < 60) return `${m} 分钟`;
    if (m < 1440) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;

    return `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`;
  }

  function basename(path) {
    return String(path).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(path);
  }

  function toolChip(tool) {
    return h("span", { class: `tool tool-${tool}`, text: TOOLS[tool] || tool, title: tool });
  }

  // ---- Running calls

  function runningCard(call) {
    const elapsed = h("span", { class: "elapsed" });
    const live = h("pre", { class: "live hidden" });
    const card = h("div", { class: "card" },
      h("div", { class: "card-head" },
        h("span", { class: "spinner", "aria-hidden": "true" }),
        toolChip(call.tool),
        h("span", { class: "summary", text: call.summary, title: call.summary }),
        call.workspace && h("span", { class: "ws", text: basename(call.workspace), title: call.workspace }),
        elapsed),
      live);

    card.startedAt = call.startedAt;
    card.elapsed = elapsed;
    card.live = live;
    elapsed.textContent = duration(Date.now() - call.startedAt);

    return card;
  }

  function showLive(card, text) {
    const pre = card.live;
    const wasHidden = pre.classList.contains("hidden");
    // Follow the output unless the reader scrolled up to look at something.
    const following = wasHidden || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;

    pre.textContent = text;
    pre.classList.remove("hidden");

    if (following) pre.scrollTop = pre.scrollHeight;
  }

  // ---- History

  function historyRow(call) {
    const failed = call.status === "error" || call.status === "cancelled";
    const body = h("div", { class: "detail" }, h("p", { class: "loading", text: "加载中…" }));
    const row = h("details", { class: `row is-${call.status}`, "data-id": call.id },
      h("summary", {},
        h("span", { class: "time", text: clock(call.startedAt) }),
        toolChip(call.tool),
        h("span", { class: "summary", text: call.summary, title: call.summary }),
        h("span", { class: "ws", text: call.workspace ? basename(call.workspace) : "", title: call.workspace }),
        h("span", { class: "dur", text: call.endedAt ? duration(call.endedAt - call.startedAt) : "" }),
        h("span", { class: `status status-${call.status}`, text: STATUS[call.status] || call.status, title: STATUS_TITLE[call.status] }),
        briefLine(call, failed)),
      body);

    row.addEventListener("toggle", () => {
      if (row.open) loadDetail(call.id, body);
    });

    return row;
  }

  /** The line under a row: what went wrong, and whether the result never reached the client. */
  function briefLine(call, failed) {
    const parts = [];

    if (failed && call.brief) parts.push(call.brief);
    if (call.undelivered) parts.push(`未送达：${UNDELIVERED}`);

    if (parts.length === 0) return undefined;

    const text = parts.join(" · ");

    return h("span", { class: call.undelivered && !failed ? "brief brief-quiet" : "brief", text, title: text });
  }

  async function loadDetail(id, body) {
    if (body.dataset.state === "loading" || body.dataset.state === "done") return;

    body.dataset.state = "loading";

    try {
      const response = await fetch(`/api/calls/${id}`);

      if (response.status === 404) {
        body.replaceChildren(h("p", { class: "note", text: "这条记录太旧，详情已经不在内存里了。" }));
        body.dataset.state = "done";

        return;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      body.replaceChildren(...renderDetail(await response.json()));
      body.dataset.state = "done";
    } catch (error) {
      body.replaceChildren(h("p", { class: "note", text: `加载失败：${error.message}。收起再展开可以重试。` }));
      body.dataset.state = "";
    }
  }

  function renderDetail(call) {
    const args = call.args || {};
    const facts = [];
    const fact = (label, value, mono) => {
      if (value === undefined || value === null || value === "") return;
      facts.push(h("dt", { text: label }), h("dd", { class: mono ? "mono" : undefined, text: String(value) }));
    };

    fact("客户端", call.client);
    fact("工作区", call.workspace, true);
    fact("开始", new Date(call.startedAt).toLocaleString("zh-CN", { hour12: false }));
    if (call.endedAt) fact("耗时", duration(call.endedAt - call.startedAt));
    fact("状态", STATUS[call.status] || call.status);
    if (call.undelivered) fact("注意", UNDELIVERED);

    switch (call.tool) {
      case "open_workspace":
        fact("路径", args.path, true);
        if (args.create) fact("不存在时创建", "是");
        break;
      case "read":
        fact("路径", args.path, true);
        if (args.offset || args.limit) fact("范围", `从第 ${args.offset || 1} 行起${args.limit ? `，最多 ${args.limit} 行` : ""}`);
        break;
      case "write":
        fact("路径", args.path, true);
        fact("大小", args.content_size);
        break;
      case "edit": {
        const shown = Array.isArray(args.edits) ? args.edits.length : 0;
        const count = typeof args.edits_count === "number" ? args.edits_count : shown;

        fact("路径", args.path, true);
        fact("修改处数", count > shown ? `${count}（下面只列出前 ${shown} 处）` : count);
        break;
      }
      case "grep":
        fact("正则", args.pattern, true);
        fact("范围", args.path, true);
        fact("文件筛选", args.glob, true);
        if (args.ignore_case) fact("忽略大小写", "是");
        if (args.files_only) fact("只列文件名", "是");
        break;
      case "glob":
        fact("模式", args.pattern, true);
        fact("目录", args.path, true);
        break;
      case "bash":
        fact("目录", args.working_directory || "（工作区根目录）", true);
        if (args.timeout) fact("超时", `${args.timeout} 秒`);
        break;
    }

    const parts = [h("dl", { class: "facts" }, facts)];

    if (call.tool === "bash") parts.push(h("p", { class: "section-label", text: "命令" }), h("pre", { text: args.command }));

    if (call.tool === "edit" && Array.isArray(args.edits)) parts.push(h("p", { class: "section-label", text: "修改" }), renderDiff(args.edits));

    if (call.tool === "write" && typeof args.content === "string") {
      parts.push(h("p", { class: "section-label", text: "写入的内容" }), h("pre", { text: args.content }));
    }

    const truncatedNote = call.outputTruncated ? (call.tool === "bash" ? "（只保留了末尾部分）" : "（只保留了开头部分）") : "";
    parts.push(
      h("p", { class: "section-label" }, call.status === "running" ? "目前的输出 " : "结果 ", h("span", { class: "note", text: truncatedNote })),
      h("pre", { text: call.output || "（无输出）" }),
    );

    return parts;
  }

  function renderDiff(edits) {
    const box = h("div", { class: "diff mono" });

    edits.forEach((edit, index) => {
      if (index > 0) box.append(h("div", { class: "sep" }));

      for (const line of String(edit.old_text ?? "").split("\n")) box.append(h("div", { class: "del", text: `- ${line}` }));
      for (const line of String(edit.new_text ?? "").split("\n")) box.append(h("div", { class: "add", text: `+ ${line}` }));
    });

    return box;
  }

  function matches(call) {
    if (filters.tool && call.tool !== filters.tool) return false;
    if (filters.errorsOnly && call.status !== "error") return false;

    if (filters.text) {
      const haystack = `${call.summary} ${call.workspace || ""} ${call.brief || ""}`.toLowerCase();

      if (!haystack.includes(filters.text)) return false;
    }

    return true;
  }

  function applyFilters() {
    for (const [id, row] of rows) row.classList.toggle("hidden", !matches(state.calls.get(id)));

    updateCounts();
  }

  // ---- Placing calls

  function place(call, open) {
    if (call.status === "running") {
      const card = runningCard(call);
      cards.set(call.id, card);
      els.running.append(card);

      const text = state.live.get(call.id);

      if (text) showLive(card, text);

      return;
    }

    const row = historyRow(call);
    rows.set(call.id, row);
    row.classList.toggle("hidden", !matches(call));
    els.history.prepend(row);

    if (open) row.open = true;
  }

  function dropOldRows() {
    while (rows.size > state.limits.calls) {
      const oldest = Math.min(...rows.keys());
      rows.get(oldest).remove();
      rows.delete(oldest);
      state.calls.delete(oldest);
    }
  }

  function updateCounts() {
    const visible = [...rows.values()].filter((row) => !row.classList.contains("hidden")).length;

    els.runningCount.textContent = String(cards.size);
    els.runningEmpty.classList.toggle("hidden", cards.size > 0);
    els.historyCount.textContent = visible === rows.size ? String(rows.size) : `${visible} / ${rows.size}`;
    els.historyEmpty.classList.toggle("hidden", visible > 0);
    els.historyEmpty.textContent = rows.size > 0
      ? "没有符合筛选条件的记录。"
      : "还没有记录。Claude Code 连接后，它在这台电脑上的每一步都会实时出现在这里。";
    document.title = cards.size > 0 ? `(${cards.size}) clouddev-base 活动` : "clouddev-base 活动";
  }

  // ---- Notices and overview

  function noticeItem(notice) {
    return h("li", {},
      h("span", { class: "time", text: clock(notice.at) }),
      h("span", { class: notice.level === "warn" ? "warn" : undefined, text: notice.message }));
  }

  function renderNotices(notices) {
    els.notices.replaceChildren(...notices.slice().reverse().map(noticeItem));
    els.noticesEmpty.classList.toggle("hidden", notices.length > 0);
  }

  function addNotice(notice) {
    els.notices.prepend(noticeItem(notice));

    while (els.notices.children.length > state.limits.notices) els.notices.lastElementChild.remove();

    els.noticesEmpty.classList.add("hidden");
  }

  function renderOverview() {
    const { client, server } = state;

    els.client.textContent = client
      ? `${client.label || client.name}（${client.name} ${client.version}，${clock(client.at)} 连接）`
      : "还没有客户端连接";
    // A long command sends no requests while it runs, so "N seconds ago" would undersell what is happening.
    els.lastRequest.textContent = cards.size > 0
      ? "现在（有调用正在执行）"
      : state.lastRequestAt ? ago(state.lastRequestAt) : "还没有请求";
    els.uptime.textContent = state.startedAt ? `${span(Date.now() - state.startedAt)}（版本 ${server ? server.version : "?"}）` : "—";
    els.mcpUrl.textContent = server ? server.mcpUrl : "—";
    els.roots.textContent = server ? server.allowedRoots.join("\n") : "—";
  }

  // ---- Events

  function applySnapshot(snapshot) {
    // After a reconnect to the same server process, keep expanded rows open; ids from an earlier process mean other calls.
    const sameServer = snapshot.startedAt === state.startedAt;
    const open = new Set(sameServer ? [...rows].filter(([, row]) => row.open).map(([id]) => id) : []);

    state.server = snapshot.server;
    state.startedAt = snapshot.startedAt;
    state.lastRequestAt = snapshot.lastRequestAt;
    state.client = snapshot.client;
    state.calls = new Map(snapshot.calls.map((call) => [call.id, call]));
    state.live = new Map(Object.entries(snapshot.live || {}).map(([id, text]) => [Number(id), text]));
    if (snapshot.limits) state.limits = snapshot.limits;

    rows.clear();
    cards.clear();
    els.history.replaceChildren();
    els.running.replaceChildren();

    for (const call of snapshot.calls) place(call, open.has(call.id));

    renderNotices(snapshot.notices || []);
    renderOverview();
    updateCounts();
  }

  function handle(event) {
    switch (event.type) {
      case "snapshot":
        applySnapshot(event);
        break;
      case "call.start":
        state.calls.set(event.call.id, event.call);
        place(event.call, false);
        updateCounts();
        break;
      case "call.output": {
        // Each event carries the whole output so far (its end, when long), already cut to size by the server.
        const card = cards.get(event.id);

        if (!card) break;

        state.live.set(event.id, event.text);
        showLive(card, event.text);
        break;
      }
      case "call.end": {
        const card = cards.get(event.call.id);

        if (card) {
          card.remove();
          cards.delete(event.call.id);
        }

        state.live.delete(event.call.id);
        state.calls.set(event.call.id, event.call);
        place(event.call, false);
        dropOldRows();
        updateCounts();
        break;
      }
      case "notice":
        addNotice(event.notice);
        break;
      case "client":
        state.client = event.client;
        renderOverview();
        break;
      case "request":
        state.lastRequestAt = event.at;
        renderOverview();
        break;
    }
  }

  function setConnection(kind) {
    const labels = { ok: "已连接服务", lost: "与服务断开，正在重连…", waiting: "正在连接…", paused: "页面在后台，暂停更新" };
    els.connection.className = `pill ${kind === "ok" ? "pill-ok" : kind === "lost" ? "pill-bad" : "pill-wait"}`;
    els.connection.textContent = labels[kind];
  }

  // A browser opens at most six connections to one host, and every open page holds one for its event stream.
  // Pages in the background therefore let go of theirs, and catch up from the snapshot when shown again.
  let source;
  let retry;

  function connect() {
    if (source || document.hidden) return;

    clearTimeout(retry);
    setConnection("waiting");
    const current = new EventSource("/api/stream");
    source = current;

    current.onopen = () => setConnection("ok");
    current.onmessage = (message) => {
      let event;

      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }

      handle(event);
    };
    current.onerror = () => {
      setConnection("lost");

      // EventSource retries by itself unless the server answered with an error status (e.g. too many open pages).
      if (current.readyState === EventSource.CLOSED && source === current) {
        source = undefined;
        retry = setTimeout(connect, 5000);
      }
    };
  }

  function disconnect() {
    clearTimeout(retry);

    if (!source) return;

    source.close();
    source = undefined;
    setConnection("paused");
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? disconnect() : connect()));

  // ---- Start

  for (const [tool, label] of Object.entries(TOOLS)) els.filterTool.append(h("option", { value: tool, text: label }));

  els.filterTool.addEventListener("change", () => {
    filters.tool = els.filterTool.value;
    applyFilters();
  });
  els.filterErrors.addEventListener("change", () => {
    filters.errorsOnly = els.filterErrors.checked;
    applyFilters();
  });
  els.filterText.addEventListener("input", () => {
    filters.text = els.filterText.value.trim().toLowerCase();
    applyFilters();
  });

  setInterval(() => {
    if (document.hidden) return;

    for (const card of cards.values()) card.elapsed.textContent = duration(Date.now() - card.startedAt);

    renderOverview();
  }, 1000);

  updateCounts();
  connect();
})();
