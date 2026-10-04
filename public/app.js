/* Pi private session UI. Native JS, no dependencies, no build step.
 *
 * All rendering is derived from authoritative SessionSnapshots delivered by
 * GET /api/session and the `snapshot` SSE events of /api/session/events.
 * Every untrusted string is inserted via textContent; nothing on this page
 * ever flows through innerHTML. */
(() => {
  "use strict";

  const API = Object.freeze({
    session: "/api/session",
    events: "/api/session/events",
    messages: "/api/session/messages",
    abort: "/api/session/abort",
    checkpoint: "/api/session/checkpoint",
    restore: "/api/session/restore",
  });

  const PENDING_PREFIX = "pi.pending.";
  const MAX_RECONNECT_DELAY_MS = 30000;
  const PINNED_SLACK_PX = 80;

  const state = {
    sessionId: null,
    snapshot: null,
    es: null,
    // Desired-live from the start so a failed initial GET schedules recovery
    // (pagehide still shuts the stream down).
    esWanted: true,
    everErrored: false,
    reconnectTimer: 0,
    reconnectDelay: 1000,
    renderKey: null,
    blockedSnapshot: null,
    hydrationToken: 0,
    snapshotSeq: 0,
    memoryPending: null,
    // True while the displayed error came from a failed hydration, so a later
    // successful hydration/SSE recovery can dismiss exactly that error.
    hydrationError: false,
    inFlight: { send: false, abort: false, checkpoint: false, restore: false },
  };

  const els = {};
  for (const id of [
    "session-chip",
    "conn-chip",
    "busy-chip",
    "model-chip",
    "workspace-chip",
    "workspace-error",
    "notices",
    "transcript",
    "inbox",
    "inbox-list",
    "pending",
    "pending-text",
    "pending-retry",
    "pending-discard",
    "flash",
    "error",
    "usage-line",
    "composer",
    "input",
    "when-busy",
    "send-btn",
    "abort-btn",
    "checkpoint-btn",
    "restore-btn",
  ])
    els[id] = document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * Pure helpers
   * ------------------------------------------------------------------ */

  /** Text of a user-message content: string or (TextContent | ImageContent)[]. */
  function contentText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (part && part.type === "text" && typeof part.text === "string") return part.text;
        if (part && part.type === "image" && part.mimeType) return `[image: ${part.mimeType}]`;
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }

  function assistantTextParts(message) {
    const out = { text: [], thinking: [], toolCalls: [] };
    for (const part of message && Array.isArray(message.content) ? message.content : []) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.length > 0)
        out.text.push(part.text);
      else if (
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        part.thinking.length > 0
      ) {
        out.thinking.push(part.thinking);
      } else if (part.type === "toolCall") out.toolCalls.push(part);
    }
    return out;
  }

  function liveOf(snapshot) {
    const docs = snapshot && snapshot.conversation && snapshot.conversation.docs;
    return docs && typeof docs === "object" ? docs["pi.live"] : undefined;
  }

  function isBusy(snapshot) {
    const live = liveOf(snapshot);
    if (!live || typeof live !== "object") return false;
    return Boolean(
      live.run || live.generation || (Array.isArray(live.tools) && live.tools.length > 0),
    );
  }

  /** Background threshold compactions keep running after the foreground turn
   * ends: not "busy" for send semantics, but abortable live work. */
  function isCompacting(snapshot) {
    const live = liveOf(snapshot);
    return Boolean(
      live &&
      typeof live === "object" &&
      Array.isArray(live.compactions) &&
      live.compactions.length > 0,
    );
  }

  function lastModel(snapshot) {
    const entries =
      snapshot && snapshot.conversation && Array.isArray(snapshot.conversation.entries)
        ? snapshot.conversation.entries
        : [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry && entry.kind === "pi.assistant" && Array.isArray(entry.model)) {
        const message = entry.model[0];
        if (message && typeof message.model === "string") {
          return typeof message.provider === "string"
            ? `${message.provider}/${message.model}`
            : message.model;
        }
      }
    }
    return null;
  }

  function usageLines(usage) {
    const lines = [];
    if (!usage || typeof usage !== "object") return lines;
    for (const bucket of ["models", "tools"]) {
      const record = usage[bucket];
      if (!record || typeof record !== "object") continue;
      for (const key of Object.keys(record)) {
        const u = record[key];
        if (!u || typeof u !== "object") continue;
        const cost =
          u.cost && typeof u.cost === "object" && typeof u.cost.total === "number"
            ? `$${u.cost.total.toFixed(4)}`
            : null;
        lines.push(
          `${key}: in ${fmtInt(u.input)} · out ${fmtInt(u.output)}` +
            (u.totalTokens !== undefined ? ` · ${fmtInt(u.totalTokens)} tok` : "") +
            (cost ? ` · ${cost}` : ""),
        );
      }
    }
    return lines;
  }

  function fmtInt(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.round(value).toLocaleString("en-US")
      : "—";
  }

  function fmtTime(ms) {
    return typeof ms === "number" ? new Date(ms).toLocaleTimeString() : "";
  }

  function shortId(value) {
    return typeof value === "string" && value.length > 10
      ? value.slice(0, 10)
      : String(value ?? "—");
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers (textContent only)
   * ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ------------------------------------------------------------------ *
   * API client — same-origin credentials, real statuses surfaced
   * ------------------------------------------------------------------ */

  async function request(path, options) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...options });
    } catch (cause) {
      throw apiError(
        0,
        `network error: ${cause && cause.message ? cause.message : "request failed"}`,
      );
    }
    if (!response.ok) {
      let message = response.statusText || `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && typeof body.error === "string") message = body.error;
      } catch {
        /* non-JSON error body: keep status text */
      }
      throw apiError(response.status, message);
    }
    if (response.status === 204) return null;
    const type = response.headers.get("content-type") || "";
    return type.includes("application/json") ? response.json() : response.text();
  }

  function apiError(status, message) {
    const error = new Error(status > 0 ? `HTTP ${status}: ${message}` : message);
    error.status = status;
    return error;
  }

  /* ------------------------------------------------------------------ *
   * Pending submission persistence (scoped to the returned sessionId)
   * ------------------------------------------------------------------ */

  function pendingKey(sessionId) {
    return PENDING_PREFIX + sessionId;
  }

  function validPending(value) {
    return value &&
      typeof value === "object" &&
      typeof value.requestId === "string" &&
      value.requestId.length > 0 &&
      typeof value.text === "string" &&
      (value.whenBusy === "steer" || value.whenBusy === "followUp")
      ? value
      : null;
  }

  function loadPending(sessionId) {
    let stored = null;
    try {
      const raw = localStorage.getItem(pendingKey(sessionId));
      if (raw) stored = validPending(JSON.parse(raw));
    } catch {
      /* storage unavailable or unreadable: fall through to memory */
    }
    if (stored) return stored;
    // Session-scoped memory fallback keeps render/retry/clear working when
    // localStorage is disabled or over quota.
    const memory = state.memoryPending;
    return memory && memory.sessionId === sessionId ? validPending(memory.pending) : null;
  }

  /** Returns true when the record also survives a reload. */
  function savePending(sessionId, pending) {
    state.memoryPending = { sessionId, pending };
    try {
      localStorage.setItem(pendingKey(sessionId), JSON.stringify(pending));
      return true;
    } catch {
      // Retained in memory only: in-page retry works, but a reload cannot
      // recover this record.
      return false;
    }
  }

  function clearPending(sessionId) {
    const memory = state.memoryPending;
    if (memory && memory.sessionId === sessionId) state.memoryPending = null;
    try {
      localStorage.removeItem(pendingKey(sessionId));
    } catch {
      /* ignore */
    }
  }

  /** Clears only the stored/memory record whose requestId matches the
   * acknowledged submission. A delayed receipt for an older request (another
   * tab or a later send may have saved a newer unresolved admission under the
   * same session-scoped key) must never erase that newer record. */
  function clearPendingRequest(sessionId, requestId) {
    const memory = state.memoryPending;
    if (
      memory &&
      memory.sessionId === sessionId &&
      memory.pending &&
      memory.pending.requestId === requestId
    )
      state.memoryPending = null;
    try {
      const key = pendingKey(sessionId);
      const raw = localStorage.getItem(key);
      if (raw) {
        const stored = validPending(JSON.parse(raw));
        if (stored && stored.requestId === requestId) localStorage.removeItem(key);
      }
    } catch {
      /* storage unavailable or unreadable: memory layer already handled */
    }
  }

  function pruneOtherPendingKeys(sessionId) {
    try {
      const stale = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PENDING_PREFIX) && key !== pendingKey(sessionId)) stale.push(key);
      }
      for (const key of stale) localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * Status surfaces
   * ------------------------------------------------------------------ */

  function setConnection(mode) {
    const label = {
      live: "live",
      connecting: "connecting…",
      reconnecting: "reconnecting…",
      offline: "offline",
    };
    els["conn-chip"].textContent = label[mode] || mode;
    els["conn-chip"].className = `chip conn-${mode}`;
  }

  function showError(error, fromHydration) {
    els.error.textContent = `Error — ${error && error.message ? error.message : "unknown error"}`;
    els.error.hidden = false;
    state.hydrationError = fromHydration === true;
  }

  function hideError() {
    els.error.hidden = true;
    els.error.textContent = "";
    state.hydrationError = false;
  }

  /** Dismisses only an error that a failed hydration produced; mutation
   * errors shown afterwards stay visible until their own flow resolves. */
  function clearHydrationError() {
    if (state.hydrationError) hideError();
  }

  function flash(message) {
    els.flash.textContent = message;
    els.flash.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => {
      els.flash.hidden = true;
      els.flash.textContent = "";
    }, 6000);
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || typeof snapshot.sessionId !== "string") return;
    state.snapshot = snapshot;
    state.snapshotSeq += 1;
    if (snapshot.sessionId !== state.sessionId) {
      state.sessionId = snapshot.sessionId;
      state.renderKey = null;
      state.memoryPending = null;
      pruneOtherPendingKeys(snapshot.sessionId);
    }
    renderHeader();
    renderNotices();
    renderTranscript();
    renderInbox();
    renderUsage();
    renderComposer();
    renderPending();
  }

  function renderHeader() {
    const snapshot = state.snapshot;
    els["session-chip"].textContent = `session ${shortId(snapshot.sessionId)}`;
    els["session-chip"].title = snapshot.sessionId;

    const busy = isBusy(snapshot);
    els["busy-chip"].textContent = busy ? "busy" : "idle";
    els["busy-chip"].className = `chip${busy ? " chip-busy" : ""}`;

    const model = lastModel(snapshot);
    els["model-chip"].textContent = `model ${model || "—"}`;

    const workspace = snapshot.workspace || {};
    const parts = [`workspace ${workspace.state || "—"}`];
    if (workspace.checkpoint && typeof workspace.checkpoint.key === "string") {
      parts.push(`ckpt ${shortId(workspace.checkpoint.key)}`);
    }
    els["workspace-chip"].textContent = parts.join(" · ");
    els["workspace-chip"].title = workspace.checkpoint
      ? `checkpoint ${workspace.checkpoint.key} at ${new Date(workspace.checkpoint.createdAt).toLocaleString()}`
      : "no checkpoint yet";
    els["workspace-chip"].className = `chip${workspace.state === "error" ? " chip-error" : ""}`;

    if (workspace.error) {
      els["workspace-error"].textContent = `Workspace error — ${workspace.error}`;
      els["workspace-error"].hidden = false;
    } else {
      els["workspace-error"].hidden = true;
      els["workspace-error"].textContent = "";
    }
  }

  function renderNotices() {
    const notices = state.snapshot.notices;
    if (!Array.isArray(notices) || notices.length === 0) {
      els.notices.hidden = true;
      els.notices.replaceChildren();
      return;
    }
    const list = el("ul");
    for (const notice of notices) {
      if (typeof notice === "string" && notice.length > 0) list.append(el("li", null, notice));
    }
    els.notices.replaceChildren(list);
    els.notices.hidden = list.children.length === 0;
  }

  /** Scroll pinning: follow only when the user is already at the bottom. */
  function isPinned() {
    return (
      els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight <
      PINNED_SLACK_PX
    );
  }

  /** Never rebuild the transcript while the user has a text selection inside it. */
  function selectionHeld() {
    const selection = document.getSelection();
    return Boolean(
      selection &&
      selection.rangeCount > 0 &&
      !selection.isCollapsed &&
      els.transcript.contains(selection.anchorNode),
    );
  }

  /** Tag a rendered top-level node with the key its reader state is stored under. */
  function keyedNode(key, node) {
    if (node && node.nodeType === 1) node.dataset.tkey = key;
    return node;
  }

  /** details/pres under a keyed holder, excluding nested keyed holders. */
  function ownUnder(holder, selector) {
    const nested = Array.from(holder.querySelectorAll("[data-tkey]"));
    return Array.from(holder.querySelectorAll(selector)).filter(
      (node) => !nested.some((keyed) => keyed.contains(node)),
    );
  }

  /**
   * Capture details expansion and nested scroll positions (scrolled tool
   * output, diagnostics pres) so a changed snapshot rebuild keeps opened
   * panels open and steady instead of resetting them.
   */
  function captureTranscriptState() {
    const open = new Set();
    const scroll = new Map();
    for (const holder of els.transcript.querySelectorAll("[data-tkey]")) {
      const key = holder.dataset.tkey;
      ownUnder(holder, "details").forEach((details, i) => {
        if (details.open) open.add(`${key}/${i}`);
      });
      ownUnder(holder, "pre").forEach((pre, i) => {
        if (pre.scrollTop > 0 || pre.scrollHeight > pre.clientHeight)
          scroll.set(`${key}/${i}`, pre.scrollTop);
      });
    }
    return { open, scroll };
  }

  function restoreTranscriptState(saved) {
    for (const holder of els.transcript.querySelectorAll("[data-tkey]")) {
      const key = holder.dataset.tkey;
      ownUnder(holder, "details").forEach((details, i) => {
        if (saved.open.has(`${key}/${i}`)) details.open = true;
      });
      ownUnder(holder, "pre").forEach((pre, i) => {
        const top = saved.scroll.get(`${key}/${i}`);
        if (top > 0) pre.scrollTop = top;
      });
    }
  }

  function renderTranscript(snapshot) {
    snapshot = snapshot || state.snapshot;
    const conversation =
      snapshot.conversation && typeof snapshot.conversation === "object"
        ? snapshot.conversation
        : { entries: [], docs: {} };
    const key = JSON.stringify([conversation, snapshot.notices]);
    if (key === state.renderKey) {
      // Matches what is already rendered: any previously queued selection-blocked
      // snapshot is stale and must never be flushed over this state.
      state.blockedSnapshot = null;
      return;
    }
    if (selectionHeld()) {
      state.blockedSnapshot = snapshot;
      return;
    }
    state.renderKey = key;
    state.blockedSnapshot = null;

    const pinned = isPinned();
    const preserved = captureTranscriptState();
    const fragment = document.createDocumentFragment();
    const entries = Array.isArray(conversation.entries) ? conversation.entries : [];

    if (entries.length === 0)
      fragment.append(
        keyedNode("empty", el("p", "empty-hint", "No messages yet — say something below.")),
      );
    entries.forEach((entry, index) => {
      fragment.append(keyedNode(`${index}:${entry && entry.kind}`, renderEntry(entry)));
    });

    const live = liveOf(snapshot);
    if (
      live &&
      typeof live === "object" &&
      (live.run ||
        live.generation ||
        (Array.isArray(live.tools) && live.tools.length) ||
        (Array.isArray(live.compactions) && live.compactions.length))
    ) {
      fragment.append(keyedNode("live", renderLive(live)));
    }

    els.transcript.replaceChildren(fragment);
    restoreTranscriptState(preserved);
    if (pinned) els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  function renderEntry(entry) {
    if (!entry || typeof entry !== "object") return el("div");
    switch (entry.kind) {
      case "pi.user":
        return renderUserEntry(entry);
      case "pi.assistant":
        return renderAssistantEntry(entry);
      case "pi.tool-result":
        return renderToolResultEntry(entry);
      case "pi.system": {
        const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
        return el(
          "p",
          "entry-note",
          `system prompt updated${message && message.content ? `: ${contentText(message.content)}` : ""}`,
        );
      }
      case "pi.reset": {
        const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
        const handoff = message ? contentText(message.content) : "";
        return el("p", "entry-note", `— context reset —${handoff ? ` (${handoff})` : ""}`);
      }
      case "pi.compaction": {
        const reason = entry.data && typeof entry.data === "object" ? entry.data.reason : undefined;
        return el("p", "entry-note", `— context compacted${reason ? ` (${reason})` : ""} —`);
      }
      default: {
        const note = el("p", "entry-note", `entry: ${String(entry.kind)}`);
        if (entry.data !== undefined && entry.data !== null)
          note.append(renderDetailsJson(entry.data));
        return note;
      }
    }
  }

  function renderUserEntry(entry) {
    const wrap = el("div", "entry entry-user");
    const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
    const bubble = el("div", "bubble");
    const head = el("div", "entry-head");
    head.append(el("span", "entry-who", "you"));
    bubble.append(head);
    const body = el("div", "msg-body");
    const text = message ? contentText(message.content) : "";
    if (text.length > 0) {
      for (const paragraph of text.split("\n")) body.append(el("p", "msg-text", paragraph));
    } else {
      body.append(el("p", "msg-text", "(empty message)"));
    }
    bubble.append(body);
    wrap.append(bubble);
    return wrap;
  }

  function renderAssistantEntry(entry) {
    const wrap = el("div", "entry entry-assistant");
    const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
    const bubble = el("div", "bubble");
    const head = el("div", "entry-head");
    head.append(el("span", "entry-who", "assistant"));
    if (message) {
      const meta = [];
      if (typeof message.model === "string")
        meta.push(
          typeof message.provider === "string"
            ? `${message.provider}/${message.model}`
            : message.model,
        );
      if (message.usage && typeof message.usage === "object") {
        meta.push(`in ${fmtInt(message.usage.input)} · out ${fmtInt(message.usage.output)}`);
      }
      if (meta.length > 0) head.append(el("span", "entry-meta", meta.join(" · ")));
    }
    bubble.append(head);

    if (!message) {
      bubble.append(el("p", "msg-text", "(assistant entry without message)"));
      wrap.append(bubble);
      return wrap;
    }

    const parts = assistantTextParts(message);
    for (const thinking of parts.thinking) {
      const details = el("details", "msg-thinking");
      details.append(el("summary", null, "thinking"));
      details.append(el("pre", null, thinking));
      bubble.append(details);
    }
    for (const text of parts.text) bubble.append(el("p", "msg-text", text));
    for (const call of parts.toolCalls) {
      bubble.append(
        el(
          "div",
          "msg-toolcall",
          `→ ${call.name ?? "tool"}(${JSON.stringify(call.arguments ?? {})})`,
        ),
      );
    }
    if (parts.text.length === 0 && parts.toolCalls.length === 0 && parts.thinking.length === 0) {
      bubble.append(el("p", "msg-text", "(no visible content)"));
    }
    if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
      bubble.append(el("p", "msg-error", `error: ${message.errorMessage}`));
    }
    wrap.append(bubble);
    return wrap;
  }

  function renderToolResultEntry(entry) {
    const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
    const isError = Boolean(message && message.isError);
    const block = el("div", `tool-block${isError ? " tool-error" : ""}`);
    const name = message && typeof message.toolName === "string" ? message.toolName : "tool";
    const head = el("div", "entry-head");
    head.append(el("span", "entry-who", isError ? `tool ${name} · error` : `tool ${name}`));
    if (
      message &&
      message.usage &&
      typeof message.usage === "object" &&
      message.usage.totalTokens !== undefined
    ) {
      head.append(el("span", "entry-meta", `${fmtInt(message.usage.totalTokens)} tok`));
    }
    block.append(head);

    const text = message ? contentText(message.content) : "";
    if (text.length > 0) block.append(el("pre", "tool-output", text));

    const details =
      entry.data &&
      typeof entry.data === "object" &&
      Array.isArray(entry.data.diagnostics) &&
      entry.data.diagnostics.length > 0
        ? entry.data.diagnostics
        : message && message.details !== undefined
          ? message.details
          : undefined;
    if (details !== undefined) block.append(renderDetailsJson(details));
    return block;
  }

  function renderDetailsJson(value) {
    const details = el("details", "tool-details");
    details.append(el("summary", null, "details"));
    let text;
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    details.append(el("pre", null, text));
    return details;
  }

  /* Live generation / tool round, from docs["pi.live"]. Transient by nature. */

  function renderLive(live) {
    const section = el("section", "live");
    if (live.run)
      section.append(
        el(
          "div",
          "live-status",
          `working${Array.isArray(live.run.inputs) ? ` · ${live.run.inputs.length} input(s) in run` : "…"}`,
        ),
      );

    if (live.generation && typeof live.generation === "object") {
      const generation = live.generation;
      if (generation.retry && typeof generation.retry === "object") {
        section.append(
          el(
            "div",
            "live-status",
            `generation retrying (attempt ${generation.attempt ?? "?"}): ${String(generation.retry.error ?? "")}`,
          ),
        );
      } else if (generation.deferred) {
        section.append(el("div", "live-status", "waiting for provider response…"));
      }
      const message = generation.message;
      if (message && typeof message === "object") {
        const parts = assistantTextParts(message);
        for (const thinking of parts.thinking) {
          const details = el("details", "msg-thinking");
          details.append(el("summary", null, "thinking"));
          details.append(el("pre", null, thinking));
          section.append(details);
        }
        for (const text of parts.text) section.append(el("div", "msg-text", text));
      }
    }

    for (const [toolIndex, slot] of (Array.isArray(live.tools) ? live.tools : []).entries()) {
      if (!slot || typeof slot !== "object") continue;
      const tool = el("div", "live-tool");
      const status =
        slot.status === "running" || slot.status === "pending" || slot.status === "done"
          ? slot.status
          : "pending";
      const head = el("div", "live-tool-head");
      head.append(`${slot.name ?? "tool"} · `);
      head.append(el("span", `tool-status-${status}`, status));
      tool.append(head);
      if (typeof slot.output === "string" && slot.output.length > 0) {
        tool.append(el("pre", "tool-output", slot.output));
      }
      if (typeof slot.droppedBytes === "number" || typeof slot.droppedLines === "number") {
        const dropped = [];
        if (typeof slot.droppedBytes === "number") dropped.push(`${slot.droppedBytes}B`);
        if (typeof slot.droppedLines === "number") dropped.push(`${slot.droppedLines} lines`);
        tool.append(el("div", "dropped-note", `output truncated: dropped ${dropped.join(", ")}`));
      }
      keyedNode(`live-tool:${String(slot.name ?? "tool")}:${toolIndex}`, tool);
      section.append(tool);
    }

    for (const compaction of Array.isArray(live.compactions) ? live.compactions : []) {
      if (!compaction || typeof compaction !== "object") continue;
      const retry =
        compaction.retry && typeof compaction.retry === "object"
          ? ` · retry: ${String(compaction.retry.error ?? "")}`
          : "";
      section.append(
        el("div", "live-status", `compacting context (${compaction.reason ?? "?"}${retry})`),
      );
    }
    return section;
  }

  function renderInbox() {
    const docs = state.snapshot.conversation && state.snapshot.conversation.docs;
    const inbox = docs && typeof docs === "object" ? docs["pi.inbox"] : undefined;
    const items = inbox && Array.isArray(inbox.items) ? inbox.items : [];
    if (items.length === 0) {
      els.inbox.hidden = true;
      els["inbox-list"].replaceChildren();
      return;
    }
    const list = el("ul");
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const line = el("li");
      if (item.mode === "steer" || item.mode === "followUp") {
        line.append(el("span", "inbox-mode", `[${item.mode}] `));
        line.append(contentText(item.content));
      } else if (item.mode === "write") {
        line.append(el("span", "inbox-mode", "[write] "));
        const kind =
          item.entry && typeof item.entry === "object" && typeof item.entry.kind === "string"
            ? item.entry.kind
            : "entry";
        line.append(kind);
      } else {
        continue;
      }
      list.append(line);
    }
    els["inbox-list"].replaceChildren(list);
    els.inbox.hidden = list.children.length === 0;
  }

  function renderUsage() {
    const docs = state.snapshot.conversation && state.snapshot.conversation.docs;
    const usage = docs && typeof docs === "object" ? docs["pi.usage"] : undefined;
    const lines = usageLines(usage);
    els["usage-line"].textContent = lines.join(" · ");
  }

  function renderComposer() {
    const snapshot = state.snapshot;
    if (!snapshot) {
      // No authoritative state yet: workspace actions stay unavailable until
      // the first snapshot loads (they are also disabled in index.html).
      els["checkpoint-btn"].disabled = true;
      els["restore-btn"].disabled = true;
      return;
    }
    const busy = isBusy(snapshot);
    // Abort must stay available while background compactions run even though
    // the foreground turn (and the busy send semantics) has ended.
    els["abort-btn"].hidden = !(busy || isCompacting(snapshot));
    els["abort-btn"].disabled = state.inFlight.abort;
    els["send-btn"].disabled = state.inFlight.send;
    const mode = els["when-busy"].value === "followUp" ? "follow up" : "steer";
    els["send-btn"].textContent = busy ? `Send · ${mode}` : "Send";
    els["checkpoint-btn"].disabled = state.inFlight.checkpoint;
    els["restore-btn"].disabled =
      state.inFlight.restore || !(state.snapshot.workspace && state.snapshot.workspace.checkpoint);
    els["restore-btn"].title =
      state.snapshot.workspace && state.snapshot.workspace.checkpoint
        ? "Replace all project files with the latest checkpoint"
        : "No checkpoint yet";
  }

  function renderPending() {
    if (!state.sessionId) return;
    const pending = loadPending(state.sessionId);
    if (!pending) {
      els["pending-text"].textContent = ""; // drop the old message preview
      els.pending.hidden = true;
      return;
    }
    const preview = pending.text.length > 120 ? `${pending.text.slice(0, 120)}…` : pending.text;
    els["pending-text"].textContent =
      `Unsent message (saved ${fmtTime(pending.savedAt)}): "${preview}"`;
    els["pending-retry"].disabled = state.inFlight.send;
    els["pending-discard"].disabled = state.inFlight.send;
    els.pending.hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  async function submitPending(pending) {
    // Pin the session this record was saved under: a snapshot for a different
    // session must not redirect the acknowledgement's clear.
    const sessionId = state.sessionId;
    state.inFlight.send = true;
    renderComposer();
    renderPending();
    try {
      await request(API.messages, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: pending.text,
          requestId: pending.requestId,
          whenBusy: pending.whenBusy,
        }),
      });
      // The returned SDK receipt is the only thing that clears a pending
      // record — and only the record for THIS requestId, never a newer
      // unresolved admission saved meanwhile.
      if (sessionId) clearPendingRequest(sessionId, pending.requestId);
      hideError();
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      state.inFlight.send = false;
      renderComposer();
      renderPending();
    }
  }

  async function onSend() {
    const text = els.input.value;
    if (text.trim().length === 0 || !state.sessionId || state.inFlight.send) return;
    // An unresolved record means the server may already have admitted the
    // earlier submission but its receipt was lost. Never overwrite it with a
    // fresh requestId: reuse the identical payload, or make the user resolve
    // the pending record before sending a different prompt.
    const unresolved = loadPending(state.sessionId);
    if (unresolved) {
      if (unresolved.text === text) {
        const reused = await submitPending(unresolved);
        if (reused && els.input.value === text) {
          els.input.value = "";
          els.input.focus();
        }
        return;
      }
      flash(
        "An unsent message above is still unresolved — retry or discard it before sending a different prompt.",
      );
      return;
    }
    // Persist requestId + payload BEFORE sending: a lost receipt is retried
    // with the exact same requestId, never a fresh one.
    const pending = {
      requestId: crypto.randomUUID(),
      text,
      whenBusy: els["when-busy"].value === "followUp" ? "followUp" : "steer",
      savedAt: Date.now(),
    };
    if (!savePending(state.sessionId, pending)) {
      flash(
        "Browser storage is unavailable — this message can be retried while the page stays open, but a reload will lose it.",
      );
    }
    const sent = await submitPending(pending);
    if (sent && els.input.value === text) {
      els.input.value = "";
      els.input.focus();
    }
    // On failure the composer text stays exactly as typed.
  }

  async function onAbort() {
    if (state.inFlight.abort) return;
    state.inFlight.abort = true;
    renderComposer();
    try {
      await request(API.abort, { method: "POST" });
      hideError();
    } catch (error) {
      showError(error);
    } finally {
      state.inFlight.abort = false;
      renderComposer();
    }
  }

  async function onCheckpoint() {
    if (state.inFlight.checkpoint || !state.snapshot) return;
    state.inFlight.checkpoint = true;
    renderComposer();
    try {
      const checkpoint = await request(API.checkpoint, { method: "POST" });
      hideError();
      if (checkpoint && typeof checkpoint === "object" && checkpoint.key) {
        flash(`Checkpoint saved (${shortId(checkpoint.key)} at ${fmtTime(checkpoint.createdAt)})`);
      }
    } catch (error) {
      showError(error);
    } finally {
      state.inFlight.checkpoint = false;
      renderComposer();
    }
  }

  async function onRestore() {
    if (state.inFlight.restore || !state.snapshot) return;
    const confirmed = window.confirm(
      "Restore replaces every file in /workspace/project with the latest checkpoint. " +
        "Changes made since that checkpoint are discarded. Continue?",
    );
    if (!confirmed) return;
    state.inFlight.restore = true;
    renderComposer();
    // Capture the client epoch before the POST: a newer SSE snapshot or a full
    // hydration landing while the request is in flight supersedes the response.
    const token = state.hydrationToken;
    const seq = state.snapshotSeq;
    try {
      const snapshot = await request(API.restore, { method: "POST" });
      hideError();
      if (
        snapshot &&
        typeof snapshot === "object" &&
        token === state.hydrationToken &&
        state.snapshotSeq === seq
      ) {
        applySnapshot(snapshot);
      }
      flash("Workspace restored from the latest checkpoint");
    } catch (error) {
      showError(error);
    } finally {
      state.inFlight.restore = false;
      renderComposer();
    }
  }

  /* ------------------------------------------------------------------ *
   * EventSource lifecycle: disconnect-safe, rehydrating, never polling
   * ------------------------------------------------------------------ */

  function stopEventSource() {
    if (state.es) {
      state.es.close();
      state.es = null;
    }
    clearTimeout(state.reconnectTimer);
  }

  function connectEvents(token) {
    if (token !== state.hydrationToken) return; // superseded hydration attempt
    stopEventSource(); // close any previous source before opening the replacement
    state.esWanted = true;
    const source = new EventSource(API.events);
    state.es = source;

    // Callbacks from a replaced or superseded source never touch state.
    const superseded = () => token !== state.hydrationToken || source !== state.es;

    source.addEventListener("snapshot", (event) => {
      if (superseded()) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      state.reconnectDelay = 1000;
      setConnection("live");
      clearHydrationError();
      applySnapshot(data);
    });

    source.addEventListener("open", () => {
      if (superseded()) return;
      setConnection("live");
      clearHydrationError();
      // After a browser-driven auto-reconnect, missed events are recovered by
      // a single full rehydrate — never by fabricating state locally.
      if (state.everErrored) {
        state.everErrored = false;
        rehydrateInBackground();
      }
    });

    source.addEventListener("error", () => {
      if (superseded()) return;
      state.everErrored = true;
      if (source.readyState === EventSource.CLOSED) {
        state.es = null;
        setConnection("reconnecting");
        scheduleReconnect();
      } else {
        setConnection("reconnecting");
      }
    });
  }

  function scheduleReconnect() {
    if (!state.esWanted) return;
    clearTimeout(state.reconnectTimer);
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    state.reconnectTimer = setTimeout(() => {
      rehydrate();
    }, delay);
  }

  /** Full recovery: fetch a fresh snapshot, then (re)open the event stream. */
  async function rehydrate() {
    const token = (state.hydrationToken += 1);
    stopEventSource();
    let snapshot;
    try {
      snapshot = await request(API.session);
    } catch (error) {
      if (token !== state.hydrationToken) return; // a newer attempt superseded this one
      setConnection("offline");
      showError(error, true);
      scheduleReconnect();
      return;
    }
    if (token !== state.hydrationToken) return;
    state.reconnectDelay = 1000;
    setConnection("live");
    // This GET succeeded: a hydration error it (or an earlier attempt) showed
    // is resolved. Never touch errors from unrelated failed mutations.
    clearHydrationError();
    applySnapshot(snapshot);
    connectEvents(token);
  }

  /** Refresh the snapshot while an auto-reconnected EventSource stays open. */
  async function rehydrateInBackground() {
    const token = state.hydrationToken;
    const seq = state.snapshotSeq;
    try {
      const snapshot = await request(API.session);
      // Drop the response when a full hydration or a newer SSE snapshot landed
      // while the GET was in flight — it can only carry older state.
      if (token !== state.hydrationToken || state.snapshotSeq !== seq) return;
      applySnapshot(snapshot);
    } catch {
      /* the stream will surface connection problems on its own */
    }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    onSend();
  });

  els.input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return; // IME composition
    event.preventDefault();
    els.composer.requestSubmit();
  });

  els["when-busy"].addEventListener("change", renderComposer);
  els["abort-btn"].addEventListener("click", onAbort);
  els["checkpoint-btn"].addEventListener("click", onCheckpoint);
  els["restore-btn"].addEventListener("click", onRestore);

  els["pending-retry"].addEventListener("click", async () => {
    if (!state.sessionId || state.inFlight.send) return;
    const pending = loadPending(state.sessionId);
    if (!pending) return;
    const sent = await submitPending(pending); // identical requestId + payload, or nothing
    if (sent && els.input.value === pending.text) {
      els.input.value = "";
      els.input.focus();
    }
  });

  els["pending-discard"].addEventListener("click", () => {
    if (!state.sessionId) return;
    clearPending(state.sessionId);
    renderPending();
  });

  // Flush renders that were blocked by an active text selection. Render the
  // CURRENT authoritative snapshot, not the previously blocked object: newer
  // snapshots may have landed (or the queued one may have been invalidated),
  // and header/composer already reflect state.snapshot.
  document.addEventListener("selectionchange", () => {
    if (state.blockedSnapshot && !selectionHeld()) {
      state.blockedSnapshot = null;
      renderTranscript();
    }
  });

  /** Explicit resume (bfcache/pageshow/online/visibility): the page is live
   * again, so re-arm the desired-live flag BEFORE the recovery GET — if that
   * GET fails, scheduleReconnect must keep retrying instead of stopping. */
  function resumeLive() {
    state.esWanted = true;
    rehydrate();
  }

  window.addEventListener("online", () => {
    resumeLive();
  });

  window.addEventListener("offline", () => {
    setConnection("offline");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.es || state.es.readyState === EventSource.CLOSED) {
      resumeLive();
    }
  });

  // A bfcache-restored page (persisted pageshow) lost its EventSource while
  // frozen; explicitly resume recovery just like online/visibility.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && (!state.es || state.es.readyState === EventSource.CLOSED)) {
      resumeLive();
    }
  });

  // Closing the page never cancels server-side work: no abort calls here.
  window.addEventListener("pagehide", () => {
    state.esWanted = false;
    state.hydrationToken += 1; // an in-flight hydration must not reopen the stream
    stopEventSource();
  });

  setConnection("connecting");
  rehydrate();
})();
