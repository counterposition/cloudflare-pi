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
    restore: "/api/session/restore",
  });

  const PENDING_PREFIX = "pi.pending.";
  const MAX_RECONNECT_DELAY_MS = 30000;
  const PINNED_SLACK_PX = 80;
  const ESC_WINDOW_MS = 1500;

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
    inFlight: { send: false, abort: false, restore: false },
    connection: "connecting",
    // Client clock when the latest snapshot arrived: while the stream is down,
    // the page says how old the state it shows is.
    snapshotAt: 0,
    // Client clock when busy was first observed: the elapsed-time fallback when
    // the run's starting entry is not committed yet.
    busySince: 0,
    autofocused: false,
    // Esc typed in a text field arms abort until this time; a second Esc
    // before then aborts. One stray Esc while typing never stops the run.
    escArmedUntil: 0,
  };

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const FINE_POINTER = window.matchMedia("(pointer: fine)");

  const els = {};
  for (const id of [
    "favicon",
    "status",
    "status-text",
    "status-detail",
    "workspace-summary",
    "session-panel",
    "fact-connection",
    "fact-session",
    "fact-model",
    "fact-workspace",
    "fact-checkpoint",
    "fact-usage",
    "panel-restore-btn",
    "announcer",
    "restore-dialog",
    "restore-body",
    "restore-busy",
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
    "composer",
    "composer-hint",
    "input",
    "send-btn",
    "followup-btn",
    "abort-btn",
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

  /** "4:12 PM" today, "Oct 3, 4:12 PM" on another day. */
  function fmtClock(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
    const date = new Date(ms);
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (date.toDateString() === new Date().toDateString()) return time;
    return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  }

  /** "just now", "23m ago", "3h ago", then a date. */
  function fmtAgo(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
    const seconds = Math.max(0, (Date.now() - ms) / 1000);
    if (seconds < 45) return "just now";
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return fmtClock(ms);
  }

  /** "0:42", "12:05", "1:02:09". Server/client clock skew is clamped at zero. */
  function fmtElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  function entriesOf(snapshot) {
    return snapshot && snapshot.conversation && Array.isArray(snapshot.conversation.entries)
      ? snapshot.conversation.entries
      : [];
  }

  function messageOf(entry) {
    return entry && Array.isArray(entry.model) ? entry.model[0] : undefined;
  }

  function entryTime(entry) {
    const message = messageOf(entry);
    return message && typeof message.timestamp === "number" ? message.timestamp : undefined;
  }

  function modelLabel(message) {
    if (!message || typeof message.model !== "string") return null;
    return typeof message.provider === "string"
      ? `${message.provider}/${message.model}`
      : message.model;
  }

  /** Assistant answers that end a run (as opposed to a tool-calling step). */
  const TERMINAL_STOPS = new Set(["stop", "error", "aborted", "length"]);

  /** Start of the current run: the first committed entry after the last
   * terminal answer, normally the prompt that started it. */
  function runStartedAt(snapshot) {
    const entries = entriesOf(snapshot);
    let start;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const message = messageOf(entry);
      if (
        entry &&
        entry.kind === "pi.assistant" &&
        message &&
        TERMINAL_STOPS.has(message.stopReason)
      )
        break;
      const time = entryTime(entry);
      if (time !== undefined) start = time;
    }
    return start;
  }

  /** The outcome of the latest finished run, for the idle headline. */
  function lastOutcome(snapshot) {
    const entries = entriesOf(snapshot);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry || (entry.kind !== "pi.assistant" && entry.kind !== "pi.user")) continue;
      const message = messageOf(entry);
      if (entry.kind === "pi.user") return { kind: "idle", at: entryTime(entry) };
      const stop = message && message.stopReason;
      const at = entryTime(entry);
      if (stop === "error") return { kind: "failed", at };
      if (stop === "aborted") return { kind: "aborted", at };
      if (stop === "length") return { kind: "length", at };
      if (stop === "stop") return { kind: "finished", at };
      return { kind: "idle", at };
    }
    return { kind: "empty" };
  }

  /** Status of one tool call from its committed result, else its live slot. */
  function toolStatus(result, slot) {
    if (result) {
      const codes = diagnosticsOf(result).map((d) => d.code);
      if (codes.includes("interrupted")) return "interrupted";
      if (codes.includes("aborted")) return "aborted";
      const message = messageOf(result);
      return message && message.isError ? "error" : "ok";
    }
    if (slot && (slot.status === "running" || slot.status === "pending")) return slot.status;
    if (slot && slot.status === "done") return "done";
    return "missing";
  }

  function diagnosticsOf(result) {
    const list = result && result.data && result.data.diagnostics;
    return Array.isArray(list) ? list.filter((d) => d && typeof d.message === "string") : [];
  }

  /** Tool output as the model saw it, minus the trailing rendered-diagnostics
   * block when the structured diagnostics are shown separately. */
  function toolOutputText(result) {
    const message = messageOf(result);
    const text = message ? contentText(message.content) : "";
    if (diagnosticsOf(result).length === 0) return text;
    return text.replace(/\n?<harness>\n[\s\S]*?\n<\/harness>\s*$/, "");
  }

  /** The one argument that identifies a call at a glance. */
  function toolSummary(name, args) {
    if (!args || typeof args !== "object") return "";
    const pick = (key) => (typeof args[key] === "string" ? args[key] : "");
    if (name === "bash") return pick("command");
    if (name === "read" || name === "write" || name === "edit" || name === "ls")
      return pick("path") || pick("file_path");
    const first = Object.values(args).find((value) => typeof value === "string");
    return typeof first === "string" ? first : "";
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
   * Markdown subset → DOM. Builds nodes and assigns textContent only, so
   * model output can never inject markup. Handles fenced code, headings,
   * lists, quotes, rules, pipe tables, inline code, bold and http(s) links;
   * anything else stays literal text. An unclosed fence (mid-stream) runs to
   * the end of the text.
   * ------------------------------------------------------------------ */

  const INLINE =
    /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

  function appendInline(parent, text) {
    let last = 0;
    // A fresh matcher per call: bold recurses, and a shared global regex
    // would lose its position.
    const pattern = new RegExp(INLINE.source, "g");
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match.index > last) parent.append(text.slice(last, match.index));
      if (match[1]) {
        parent.append(el("code", "md-code-inline", match[2].trim()));
      } else if (match[3] !== undefined) {
        const strong = el("strong");
        appendInline(strong, match[3]);
        parent.append(strong);
      } else {
        const link = el("a", null, match[4]);
        link.href = match[5];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      }
      last = pattern.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
  const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function tableCells(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function renderMarkdown(text) {
    const root = el("div", "md");
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      const p = el("p");
      appendInline(p, paragraph.join("\n"));
      root.append(p);
      paragraph = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const fence = FENCE.exec(line);
      if (fence) {
        flush();
        const body = [];
        for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence[1]); i += 1)
          body.push(lines[i]);
        const pre = el("pre", "md-pre");
        const code = el("code", null, body.join("\n"));
        if (fence[2]) pre.dataset.lang = fence[2];
        pre.append(code);
        root.append(pre);
        continue;
      }
      if (line.trim() === "") {
        flush();
        continue;
      }
      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        flush();
        const node = el("p", `md-h md-h${Math.min(heading[1].length, 3)}`);
        appendInline(node, heading[2]);
        root.append(node);
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flush();
        root.append(el("hr"));
        continue;
      }
      if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
        flush();
        const wrap = el("div", "md-table");
        const table = el("table");
        const headRow = el("tr");
        for (const cell of tableCells(line)) {
          const th = el("th");
          appendInline(th, cell);
          headRow.append(th);
        }
        table.append(el("thead"));
        table.tHead.append(headRow);
        const body = el("tbody");
        for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i += 1) {
          const row = el("tr");
          for (const cell of tableCells(lines[i])) {
            const td = el("td");
            appendInline(td, cell);
            row.append(td);
          }
          body.append(row);
        }
        i -= 1;
        table.append(body);
        wrap.append(table);
        root.append(wrap);
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i += 1)
          quote.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i -= 1;
        const block = el("blockquote");
        block.append(...renderMarkdown(quote.join("\n")).childNodes);
        root.append(block);
        continue;
      }
      const item = LIST_ITEM.exec(line);
      if (item) {
        flush();
        const ordered = /\d/.test(item[2]);
        const list = el(ordered ? "ol" : "ul");
        if (ordered && parseInt(item[2], 10) !== 1) list.start = parseInt(item[2], 10);
        let current = null;
        for (; i < lines.length; i += 1) {
          const next = LIST_ITEM.exec(lines[i]);
          if (next && /\d/.test(next[2]) === ordered && next[1].length <= item[1].length + 1) {
            current = el("li");
            appendInline(current, next[3]);
            list.append(current);
          } else if (current && /^\s+\S/.test(lines[i])) {
            // Continuation or nested line: keep it inside the current item.
            current.append("\n");
            appendInline(current, lines[i].trim());
          } else {
            break;
          }
        }
        i -= 1;
        root.append(list);
        continue;
      }
      paragraph.push(line);
    }
    flush();
    return root;
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

  const CONNECTION_LABEL = {
    live: "Live",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    offline: "Offline",
  };

  function setConnection(mode) {
    state.connection = mode;
    els["fact-connection"].textContent = CONNECTION_LABEL[mode] || mode;
    renderStatus();
  }

  /**
   * The one-line answer to "what is pi doing?": connection problems first
   * (the rest of the page may be stale), then live work, then the outcome of
   * the last run. Mirrored into the tab title and favicon for background tabs.
   */
  function statusLine() {
    const snapshot = state.snapshot;
    if (state.connection !== "live" || !snapshot) {
      const shown = state.snapshotAt ? `Showing state from ${fmtClock(state.snapshotAt)}` : "";
      if (state.connection === "offline") return { tone: "danger", text: "Offline", detail: shown };
      if (state.connection === "reconnecting")
        return { tone: "warn", text: "Reconnecting…", detail: shown };
      return { tone: "warn", text: "Connecting…", detail: "" };
    }
    if (isBusy(snapshot)) {
      const started = runStartedAt(snapshot) ?? state.busySince;
      return {
        tone: "working",
        text: "Working",
        detail: started ? fmtElapsed(Date.now() - started) : "",
      };
    }
    if (isCompacting(snapshot)) return { tone: "working", text: "Compacting context", detail: "" };
    const outcome = lastOutcome(snapshot);
    const ago = outcome.at ? fmtAgo(outcome.at) : "";
    switch (outcome.kind) {
      case "failed":
        return { tone: "danger", text: "Last run failed", detail: ago };
      case "aborted":
        return { tone: "warn", text: "Aborted", detail: ago };
      case "length":
        return { tone: "warn", text: "Stopped at output limit", detail: ago };
      case "finished":
        return { tone: "ok", text: "Finished", detail: ago };
      case "empty":
        return { tone: "idle", text: "Ready", detail: "" };
      default:
        return { tone: "idle", text: "Idle", detail: ago };
    }
  }

  const TONE_COLOR = {
    working: "#e0a84c",
    ok: "#6fcf97",
    warn: "#f0864a",
    danger: "#ff7a6b",
    idle: "#a8a39b",
  };

  function renderStatus() {
    const line = statusLine();
    els.status.className = `status status-${line.tone}`;
    els["status-text"].textContent = line.text;
    els["status-detail"].textContent = line.detail;
    document.title = `${line.text}${line.detail && line.tone === "working" ? ` ${line.detail}` : ""} — pi`;
    announce(line.text);
    if (renderStatus.tone !== line.tone) {
      renderStatus.tone = line.tone;
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
        `<rect width="32" height="32" rx="6" fill="#1d1c1a"/>` +
        `<path d="M8 11h16M12.5 11v12M19.5 11v9.5c0 1.5.8 2.5 2.5 2.5" fill="none" stroke="#eeece8" stroke-width="2.6" stroke-linecap="round"/>` +
        // Trouble changes shape here too: warnings are a hollow ring.
        (line.tone === "warn"
          ? `<circle cx="25" cy="7" r="5" fill="#1d1c1a"/><circle cx="25" cy="7" r="3.6" fill="none" stroke="${TONE_COLOR.warn}" stroke-width="2.4"/>`
          : `<circle cx="25" cy="7" r="5" fill="${TONE_COLOR[line.tone]}" stroke="#1d1c1a" stroke-width="2"/>`) +
        `</svg>`;
      els.favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }
  }

  const SPOKEN = { Working: "pi is working", Finished: "pi finished" };
  const SILENT = new Set(["Connecting…", "Idle", "Ready"]);

  /**
   * Screen readers hear state changes only, never the ticking elapsed time or
   * relative ages. The state found on page load is the baseline, not news.
   */
  function announce(text) {
    if (announce.last === text) return;
    const first = announce.last === undefined || announce.last === "Connecting…";
    announce.last = text;
    if (first || SILENT.has(text)) return;
    els.announcer.textContent = SPOKEN[text] || text;
  }

  /**
   * Save line under the status. Every write, edit and bash call is checkpointed
   * before it reports success, so when pi is idle the latest checkpoint is
   * exactly the workspace. While pi works, only the last save time is claimed.
   */
  function renderWorkspaceSummary() {
    const snapshot = state.snapshot;
    const workspace = (snapshot && snapshot.workspace) || {};
    const checkpoint = workspace.checkpoint;
    const at = checkpoint && typeof checkpoint.createdAt === "number" ? checkpoint.createdAt : null;
    let saved;
    if (at === null) saved = "No changes saved yet";
    else if (snapshot && (isBusy(snapshot) || isCompacting(snapshot)))
      saved = `Last saved ${fmtAgo(at)}`;
    else saved = `All changes saved · ${fmtAgo(at)}`;
    const prefix = {
      starting: "Workspace starting",
      restoring: "Restoring workspace",
      error: "Workspace error",
    }[workspace.state];
    els["workspace-summary"].textContent = prefix ? `${prefix} · ${saved}` : saved;
    els["workspace-summary"].classList.toggle("is-error", workspace.state === "error");
    els["workspace-summary"].title =
      at === null
        ? "pi saves the workspace automatically after every change it makes"
        : `Saved automatically after every change. Latest checkpoint: ${new Date(at).toLocaleString()}`;
  }

  /** Steady clock: elapsed time while working, relative ages otherwise. */
  setInterval(() => {
    if (!state.snapshot) return;
    renderStatus();
    renderWorkspaceSummary();
  }, 1000);

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

  /** Transient confirmation under the transcript. tone: "ok" (default) or "warn". */
  function flash(message, tone) {
    els.flash.textContent = message;
    els.flash.className = `flash${tone === "warn" ? " flash-warn" : ""}`;
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
    // Panels below the transcript (queue, pending) can change its height after
    // it renders, so bottom-pinning is decided once here and re-applied last.
    const pinned = isPinned();
    state.snapshotAt = Date.now();
    const busy = isBusy(snapshot);
    if (busy && !state.busySince) state.busySince = Date.now();
    if (!busy) state.busySince = 0;
    renderStatus();
    renderWorkspaceSummary();
    renderFacts();
    renderNotices();
    renderTranscript();
    renderInbox();
    renderComposer();
    renderPending();
    if (pinned && !state.blockedSnapshot) els.transcript.scrollTop = els.transcript.scrollHeight;
    autofocusComposer();
  }

  /** The Session panel: identifiers and accounting kept out of the header. */
  function renderFacts() {
    const snapshot = state.snapshot;
    els["fact-session"].textContent = snapshot.sessionId;
    els["fact-model"].textContent = lastModel(snapshot) || "—";

    const workspace = snapshot.workspace || {};
    els["fact-workspace"].textContent = workspace.state || "—";
    els["fact-checkpoint"].textContent =
      workspace.checkpoint && typeof workspace.checkpoint.createdAt === "number"
        ? `${new Date(workspace.checkpoint.createdAt).toLocaleString()} · ${shortId(workspace.checkpoint.key)}`
        : "None yet";

    const docs = snapshot.conversation && snapshot.conversation.docs;
    const lines = usageLines(docs && typeof docs === "object" ? docs["pi.usage"] : undefined);
    // With a single model the label repeats the Model row above, so drop it.
    const shown = lines.length === 1 ? [lines[0].slice(lines[0].indexOf(": ") + 2)] : lines;
    els["fact-usage"].replaceChildren(
      ...(shown.length > 0 ? shown.map((line) => el("span", "fact-line", line)) : ["—"]),
    );

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

  const FOCUSABLE = "summary, a[href], button";

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
    // Keyboard focus inside the transcript (a step summary, a link) is
    // recorded by holder key and position so a rebuild can put it back.
    let focus = null;
    const active = document.activeElement;
    const holder = active && els.transcript.contains(active) ? active.closest("[data-tkey]") : null;
    if (holder) {
      const index = ownUnder(holder, FOCUSABLE).indexOf(active);
      if (index >= 0) focus = { key: holder.dataset.tkey, index };
    }
    return { open, scroll, focus };
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
    if (saved.focus) {
      const holder = Array.from(els.transcript.querySelectorAll("[data-tkey]")).find(
        (node) => node.dataset.tkey === saved.focus.key,
      );
      const target = holder ? ownUnder(holder, FOCUSABLE)[saved.focus.index] : undefined;
      if (target) target.focus({ preventScroll: true });
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
    const live = liveOf(snapshot);

    // Each tool call renders as one step together with its result (or its
    // live slot while it runs), so results are indexed by call id here and
    // skipped where they appear on their own in the entry list.
    // turnStarted: a "pi" author line already opened this turn (since the last
    // user message). openSteps: the step list the previous assistant message
    // ended with, which a following tool-only message continues.
    const ctx = {
      results: new Map(),
      slots: new Map(),
      placed: new Set(),
      lastModel: null,
      turnStarted: false,
      openSteps: null,
    };
    for (const entry of entries) {
      const message = messageOf(entry);
      if (entry && entry.kind === "pi.tool-result" && message && message.toolCallId)
        ctx.results.set(message.toolCallId, entry);
    }
    for (const slot of live && Array.isArray(live.tools) ? live.tools : []) {
      if (slot && typeof slot.callId === "string") ctx.slots.set(slot.callId, slot);
    }

    if (entries.length === 0)
      fragment.append(
        keyedNode("empty", el("p", "empty-hint", "No messages yet. Ask pi to do something.")),
      );
    entries.forEach((entry, index) => {
      const node = renderEntry(entry, ctx);
      if (node) fragment.append(keyedNode(`${index}:${entry && entry.kind}`, node));
    });

    if (live && typeof live === "object") {
      const section = renderLive(live, ctx);
      if (section) fragment.append(keyedNode("live", section));
    }

    els.transcript.replaceChildren(fragment);
    restoreTranscriptState(preserved);
    if (pinned) els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  function renderEntry(entry, ctx) {
    if (!entry || typeof entry !== "object") return el("div");
    switch (entry.kind) {
      case "pi.user":
        ctx.turnStarted = false;
        ctx.openSteps = null;
        return renderUserEntry(entry);
      case "pi.assistant":
        return renderAssistantEntry(entry, ctx);
      case "pi.tool-result": {
        const message = messageOf(entry);
        if (message && ctx.placed.has(message.toolCallId)) return null;
        // A result whose call is not in the transcript still gets a step.
        const name = message && typeof message.toolName === "string" ? message.toolName : "tool";
        const wrap = el("div", "entry entry-steps steps");
        wrap.append(renderToolStep(name, undefined, entry, undefined));
        return wrap;
      }
      case "pi.system": {
        ctx.openSteps = null;
        const message = messageOf(entry);
        const text = message && message.content ? contentText(message.content) : "";
        return el(
          "p",
          "entry-note",
          text ? `Instructions updated: ${text}` : "Instructions updated",
        );
      }
      case "pi.reset": {
        ctx.openSteps = null;
        const message = messageOf(entry);
        const handoff = message ? contentText(message.content) : "";
        return el("p", "entry-note", `Context reset${handoff ? `: ${handoff}` : ""}`);
      }
      case "pi.compaction": {
        ctx.openSteps = null;
        const reason = entry.data && typeof entry.data === "object" ? entry.data.reason : undefined;
        return el("p", "entry-note", `Context compacted${reason ? ` (${reason})` : ""}`);
      }
      default: {
        const note = el("p", "entry-note", `entry: ${String(entry.kind)}`);
        if (entry.data !== undefined && entry.data !== null)
          note.append(renderDetailsJson(entry.data));
        return note;
      }
    }
  }

  function entryHead(who, entry, meta) {
    const head = el("div", "entry-head");
    head.append(el("span", "entry-who", who));
    const time = entryTime(entry);
    if (time !== undefined) {
      const stamp = el("time", "entry-time", fmtClock(time));
      stamp.dateTime = new Date(time).toISOString();
      if (meta) stamp.title = meta;
      head.append(stamp);
    }
    return head;
  }

  function renderUserEntry(entry) {
    const wrap = el("div", "entry entry-user");
    const message = messageOf(entry);
    const bubble = el("div", "bubble");
    bubble.append(entryHead("You", entry));
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

  /**
   * One pi turn reads as: one "pi" author line, then its text and tool steps in
   * order. Consecutive tool-only messages extend the same step list instead of
   * opening a new box each, and later messages in the turn carry no repeated
   * author line.
   */
  function renderAssistantEntry(entry, ctx) {
    const message = messageOf(entry);
    if (!message) {
      const wrap = el("div", "entry entry-assistant");
      wrap.append(el("p", "msg-text", "(assistant entry without message)"));
      return wrap;
    }
    const parts = assistantTextParts(message);
    const failed = typeof message.errorMessage === "string" && message.errorMessage.length > 0;
    const toolOnly =
      parts.toolCalls.length > 0 &&
      parts.text.length === 0 &&
      parts.thinking.length === 0 &&
      !failed;

    const appendSteps = (list) => {
      for (const call of parts.toolCalls) {
        const id = typeof call.id === "string" ? call.id : undefined;
        const result = id ? ctx.results.get(id) : undefined;
        const slot = id ? ctx.slots.get(id) : undefined;
        if (id) ctx.placed.add(id);
        list.append(renderToolStep(call.name ?? "tool", call.arguments, result, slot));
      }
    };

    // A tool-only message straight after another message's steps continues them.
    if (toolOnly && ctx.openSteps) {
      appendSteps(ctx.openSteps);
      return null;
    }

    const wrap = el("div", "entry entry-assistant");
    const bubble = el("div", "bubble");
    const model = modelLabel(message);
    if (!ctx.turnStarted) {
      const meta = [];
      if (model) meta.push(model);
      if (message.usage && typeof message.usage === "object")
        meta.push(`in ${fmtInt(message.usage.input)} · out ${fmtInt(message.usage.output)} tokens`);
      const head = entryHead("pi", entry, meta.join(" · "));
      // Name the model only when it changes, instead of on every reply.
      if (model && model !== ctx.lastModel && ctx.lastModel !== null)
        head.append(el("span", "entry-model", model));
      bubble.append(head);
      ctx.turnStarted = true;
    }
    if (model) ctx.lastModel = model;

    for (const thinking of parts.thinking) bubble.append(renderThinking(thinking));
    for (const text of parts.text) bubble.append(renderMarkdown(text));
    if (
      !failed &&
      parts.text.length === 0 &&
      parts.toolCalls.length === 0 &&
      parts.thinking.length === 0
    )
      bubble.append(el("p", "msg-text msg-empty", "(no visible content)"));
    if (failed) bubble.append(el("p", "msg-error", message.errorMessage));
    if (bubble.childNodes.length > 0) wrap.append(bubble);

    if (parts.toolCalls.length > 0) {
      const steps = el("div", "steps");
      appendSteps(steps);
      wrap.append(steps);
      ctx.openSteps = steps;
    } else {
      ctx.openSteps = null;
    }
    return wrap;
  }

  function renderThinking(thinking) {
    const details = el("details", "msg-thinking");
    details.append(el("summary", null, "Thinking"));
    details.append(el("pre", null, thinking));
    return details;
  }

  const STEP_LABEL = {
    ok: "done",
    error: "error",
    interrupted: "interrupted",
    aborted: "aborted",
    running: "running",
    pending: "pending",
    done: "done",
    missing: "no result",
  };

  /**
   * One tool call as a collapsible step: name, identifying argument and
   * status in the summary; output, diagnostics and raw data inside.
   */
  function renderToolStep(name, args, result, slot) {
    const status = toolStatus(result, slot);
    const step = el("details", `step step-${status}`);
    const summary = el("summary", "step-summary");
    summary.append(el("span", "step-dot"));
    summary.append(el("span", "step-name", String(name)));
    const target = toolSummary(name, args);
    if (target) summary.append(el("code", "step-target", target.split("\n")[0]));
    summary.append(el("span", "step-status", STEP_LABEL[status]));
    step.append(summary);

    const body = el("div", "step-body");
    if (status === "interrupted") {
      body.append(
        el(
          "p",
          "step-note step-note-warn",
          "This command was cut off before it finished, for example by a restart. " +
            "It may have partly run. It was not run again.",
        ),
      );
    }

    const output = result
      ? toolOutputText(result)
      : slot && typeof slot.output === "string"
        ? slot.output
        : "";
    if (output.length > 0) body.append(el("pre", "tool-output", output));
    else if (result && status !== "interrupted") body.append(el("p", "step-note", "No output."));
    else if (status === "running") body.append(el("p", "step-note", "Running…"));

    if (
      slot &&
      !result &&
      (typeof slot.droppedBytes === "number" || typeof slot.droppedLines === "number")
    ) {
      const dropped = [];
      if (typeof slot.droppedBytes === "number") dropped.push(`${slot.droppedBytes} bytes`);
      if (typeof slot.droppedLines === "number") dropped.push(`${slot.droppedLines} lines`);
      body.append(el("p", "step-note", `Output trimmed: ${dropped.join(", ")} not shown.`));
    }

    const diagnostics = result
      ? diagnosticsOf(result)
      : slot && Array.isArray(slot.diagnostics)
        ? slot.diagnostics
        : [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === "interrupted") continue;
      const severity =
        diagnostic.severity === "error" || diagnostic.severity === "warn"
          ? diagnostic.severity
          : "info";
      body.append(el("p", `step-note step-note-${severity}`, diagnostic.message));
    }

    const command = toolSummary(name, args);
    if (command.includes("\n") || command.length > 80)
      body.append(el("pre", "step-command", command));
    if (
      args &&
      typeof args === "object" &&
      Object.keys(args).some((key) => !command || args[key] !== command)
    )
      body.append(renderDetailsJson(args, "Arguments"));
    const message = messageOf(result);
    if (message && message.details !== undefined)
      body.append(renderDetailsJson(message.details, "Details"));
    step.append(body);
    return step;
  }

  function renderDetailsJson(value, label) {
    const details = el("details", "tool-details");
    details.append(el("summary", null, label || "Details"));
    let text;
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    details.append(el("pre", null, text));
    return details;
  }

  /* Live generation, retries and compactions, from docs["pi.live"]. Tool calls
   * already shown as steps in the transcript are not repeated here. */

  function renderLive(live, ctx) {
    const section = el("section", "live");
    section.setAttribute("aria-label", "Current work");
    let content = false;

    if (live.generation && typeof live.generation === "object") {
      const generation = live.generation;
      if (generation.retry && typeof generation.retry === "object") {
        const at =
          typeof generation.retry.at === "number" ? ` at ${fmtClock(generation.retry.at)}` : "";
        section.append(
          el(
            "p",
            "live-status live-status-warn",
            `Model request failed; retrying${at} (attempt ${generation.attempt ?? "?"}). ${String(generation.retry.error ?? "")}`,
          ),
        );
        content = true;
      } else if (generation.deferred) {
        section.append(el("p", "live-status", "Waiting for the model's response…"));
        content = true;
      }
      const message = generation.message;
      if (message && typeof message === "object") {
        const parts = assistantTextParts(message);
        if (parts.thinking.length > 0 || parts.text.length > 0) {
          // The reply being written, styled like the reply it will become.
          const bubble = el("div", "bubble bubble-live");
          const head = el("div", "entry-head");
          head.append(el("span", "entry-who", "pi"), el("span", "entry-time", "writing…"));
          bubble.append(head);
          for (const thinking of parts.thinking) bubble.append(renderThinking(thinking));
          for (const text of parts.text) bubble.append(renderMarkdown(text));
          section.append(bubble);
          content = true;
        }
      }
    }

    const loose = (Array.isArray(live.tools) ? live.tools : []).filter(
      (slot) => slot && typeof slot === "object" && !ctx.placed.has(slot.callId),
    );
    if (loose.length > 0) {
      const steps = el("div", "steps");
      loose.forEach((slot, index) => {
        steps.append(
          keyedNode(
            `live-tool:${String(slot.name ?? "tool")}:${index}`,
            renderToolStep(slot.name ?? "tool", undefined, undefined, slot),
          ),
        );
      });
      section.append(steps);
      content = true;
    }

    for (const compaction of Array.isArray(live.compactions) ? live.compactions : []) {
      if (!compaction || typeof compaction !== "object") continue;
      const retry =
        compaction.retry && typeof compaction.retry === "object"
          ? `; retrying after: ${String(compaction.retry.error ?? "")}`
          : "";
      section.append(
        el("p", "live-status", `Compacting context (${compaction.reason ?? "?"}${retry})`),
      );
      content = true;
    }

    // Busy with nothing streaming yet: a quiet working line at the reading
    // position, so the bottom of the transcript never looks finished.
    if (!content && (live.run || live.generation)) {
      const placedRunning = Array.from(ctx.slots.values()).some(
        (slot) => slot && slot.status === "running" && ctx.placed.has(slot.callId),
      );
      if (placedRunning) return null;
      section.append(el("p", "live-status live-working", "Working…"));
      content = true;
    }
    return content ? section : null;
  }

  const INBOX_MODE = { steer: "Steer", followUp: "Follow up", write: "Write" };

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
        line.append(el("span", "inbox-mode", INBOX_MODE[item.mode]));
        line.append(contentText(item.content));
      } else if (item.mode === "write") {
        line.append(el("span", "inbox-mode", INBOX_MODE.write));
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

  /** Shortcut hint under the message box: what Enter does right now. */
  function composerHint(busy, abortable) {
    const alt = IS_MAC ? "⌥" : "Alt";
    const hint = el("span");
    const key = (label) => el("kbd", null, label);
    if (busy) {
      hint.append(key("Enter"), " steer · ", key(alt), key("Enter"), " follow up");
    } else {
      hint.append(key("Enter"), " send · ", key("Shift"), key("Enter"), " new line");
    }
    if (abortable && Date.now() < state.escArmedUntil) {
      // Second-press prompt after one Esc in a text field.
      const armed = el("span", "hint-armed");
      armed.append("Press ", key("Esc"), " again to abort");
      return armed;
    }
    if (abortable) hint.append(" · ", key("Esc"), key("Esc"), " abort");
    return hint;
  }

  function renderComposer() {
    const snapshot = state.snapshot;
    const restore = els["panel-restore-btn"];
    if (!snapshot) {
      // No authoritative state yet: Restore stays unavailable until the first
      // snapshot loads (it is also disabled in index.html).
      restore.disabled = true;
      return;
    }
    const busy = isBusy(snapshot);
    // Abort must stay available while background compactions run even though
    // the foreground turn (and the busy send semantics) has ended.
    const abortable = busy || isCompacting(snapshot);
    els["abort-btn"].hidden = !abortable;
    els["abort-btn"].disabled = state.inFlight.abort;
    // While pi works, a message either steers the current run or waits as a
    // follow up; both are offered at send time instead of a standing setting.
    els["send-btn"].textContent = busy ? "Steer" : "Send";
    els["send-btn"].disabled = state.inFlight.send;
    els["followup-btn"].hidden = !busy;
    els["followup-btn"].disabled = state.inFlight.send;
    els["composer-hint"].replaceChildren(composerHint(busy, abortable));

    const hasCheckpoint = Boolean(snapshot.workspace && snapshot.workspace.checkpoint);
    restore.disabled = state.inFlight.restore || !hasCheckpoint;
    restore.title = hasCheckpoint
      ? "Replace all project files with the latest checkpoint"
      : "No checkpoint yet";
  }

  /** Put the caret in the message box once, on devices with a keyboard and
   * only when nothing else has focus (phones would pop their keyboard). */
  function autofocusComposer() {
    if (state.autofocused || !FINE_POINTER.matches) return;
    state.autofocused = true;
    if (document.activeElement === document.body || document.activeElement === null)
      els.input.focus({ preventScroll: true });
  }

  function fitInput() {
    els.input.style.height = "auto";
    els.input.style.height = `${Math.min(els.input.scrollHeight + 2, window.innerHeight * 0.4)}px`;
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

  /** whenBusy: "steer" (Enter / Steer) or "followUp" (Alt+Enter / Follow up).
   * It only matters if pi is working when the server admits the message. */
  async function onSend(whenBusy) {
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
          fitInput();
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
      whenBusy: whenBusy === "followUp" ? "followUp" : "steer",
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
      fitInput();
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
      flash("Abort requested", "warn");
    } catch (error) {
      showError(error);
    } finally {
      state.inFlight.abort = false;
      renderComposer();
    }
  }

  /** In-page confirmation naming exactly which checkpoint replaces the files.
   * Resolves true only for an explicit "Restore checkpoint". */
  function confirmRestore(checkpoint) {
    const dialog = els["restore-dialog"];
    const when =
      typeof checkpoint.createdAt === "number"
        ? `from ${fmtAgo(checkpoint.createdAt)} (${fmtClock(checkpoint.createdAt)} · ${String(checkpoint.key).slice(0, 8)})`
        : `${String(checkpoint.key).slice(0, 8)}`;
    els["restore-body"].textContent =
      `Every file in /workspace/project is replaced with the checkpoint ${when}. ` +
      "Changes made since then are lost.";
    els["restore-busy"].hidden = !isBusy(state.snapshot);
    if (els["session-panel"].matches(":popover-open")) els["session-panel"].hidePopover();
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "restore"), {
        once: true,
      });
    });
  }

  async function onRestore() {
    if (state.inFlight.restore || !state.snapshot) return;
    const checkpoint = state.snapshot.workspace && state.snapshot.workspace.checkpoint;
    if (!checkpoint) return;
    if (!(await confirmRestore(checkpoint))) return;
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
    onSend("steer");
  });

  // Pi's own keys: Enter sends (steering while pi works), Alt/Option+Enter
  // queues a follow up, Shift+Enter is a new line.
  els.input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return; // IME composition
    event.preventDefault();
    onSend(event.altKey ? "followUp" : "steer");
  });

  els.input.addEventListener("input", fitInput);

  els["followup-btn"].addEventListener("click", () => onSend("followUp"));
  els["abort-btn"].addEventListener("click", onAbort);
  els["panel-restore-btn"].addEventListener("click", onRestore);

  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    els.input.focus();
  });

  for (const node of document.querySelectorAll(".kbd-alt")) node.textContent = IS_MAC ? "⌥" : "Alt";

  function editableTarget(target) {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    );
  }

  // Page-wide keys. Esc aborts only while Abort is offered and no panel is
  // open (Esc closes the panel first); "/" jumps to the message box.
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      if (els["session-panel"].matches(":popover-open") || els["restore-dialog"].open) return;
      if (els["abort-btn"].hidden || els["abort-btn"].disabled) return;
      if (editableTarget(event.target) && Date.now() >= state.escArmedUntil) {
        state.escArmedUntil = Date.now() + ESC_WINDOW_MS;
        renderComposer();
        clearTimeout(state.escTimer);
        state.escTimer = setTimeout(renderComposer, ESC_WINDOW_MS);
        return;
      }
      event.preventDefault();
      state.escArmedUntil = 0;
      onAbort();
      return;
    }
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (editableTarget(event.target)) return;
      event.preventDefault();
      els.input.focus();
    }
  });

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
