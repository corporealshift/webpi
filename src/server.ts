import { createServer } from "http";
import { WebSocketServer, WebSocket as WSWebSocket } from "ws";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  SessionManager,
  createAgentSession,
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ClientCommand, SessionInfo, ServerEvent, TokenDayStats } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "",
  ".pi",
  "agent",
);

// ─── Per-session state ──────────────────────────────────────────────────────
//
// One SessionState per session file, shared across all web clients viewing it.
// State machine:
//   driver = "none"     — nobody writing; passive file watch
//   driver = "external" — another process (pi-CLI) is appending to the file
//   driver = "self"     — we own an AgentSession and are driving
//
// Observer mode = driver is "none" or "external". Owner mode = "self".

type Driver = "none" | "external" | "self";

interface SessionState {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  sessionName: string | undefined;
  clients: Set<Client>;
  // File-watch state
  watcher: fs.FSWatcher | null;
  fileSize: number;
  fileTail: string;
  knownEntryIds: Set<string>;
  externalIdleTimer: NodeJS.Timeout | null;
  // Grace timer: releases an idle session a while after its last viewer leaves.
  idleReleaseTimer: NodeJS.Timeout | null;
  // Owner-mode state
  agentSession: AgentSession | null;
  agentUnsubscribe: (() => void) | null;
  driver: Driver;
}

type Client = WSWebSocket & {
  clientId: string;
  subscribedSessionFile: string | null;
};

const sessions = new Map<string, SessionState>();
const clients = new Set<Client>();
let clientIdCounter = 0;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function shortId(id: string): string {
  return id ? id.slice(0, 8) : "????????";
}
function slog(s: SessionState, ...args: unknown[]): void {
  console.log(`${ts()} [${shortId(s.sessionId)}]`, ...args);
}
function preview(text: string, n = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * Determine whether a session is currently "working" (streaming / actively driven).
 *
 * For self-driven sessions: mirrors agentSession.isStreaming.
 * For externally driven sessions: the 15s file-watch idle timer acts as heartbeat —
 *   timer present = someone is writing (working), timer absent = idle.
 */
function computeActivity(s: SessionState): boolean {
  if (s.driver === "self") return !!s.agentSession?.isStreaming;
  if (s.driver === "external") return s.externalIdleTimer !== null;
  return false;
}

// ─── JSONL helpers ──────────────────────────────────────────────────────────

interface JsonlEntry {
  id: string;
  type: string;
  raw: any;
}

function parseJsonlChunk(text: string): { entries: JsonlEntry[]; leftover: string } {
  const lines = text.split("\n");
  const leftover = lines.pop() ?? "";
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed);
      entries.push({ id: raw.id ?? "", type: raw.type ?? "", raw });
    } catch {
      // ignore malformed lines (partial writes)
    }
  }
  return { entries, leftover };
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeMessage(msg: any, opts: { finalized: boolean }): any {
  const content = msg.content;
  const parts: { type: string; text?: string; toolName?: string; toolCallId?: string; args?: Record<string, unknown> }[] = [];

  if (typeof content === "string") {
    parts.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === "text" && c.text) {
        parts.push({ type: "text", text: c.text });
      } else if (c.type === "thinking" && c.thinking) {
        parts.push({ type: "thinking", text: c.thinking });
      } else if (c.type === "toolCall" || c.type === "tool_use") {
        parts.push({
          type: "toolCall",
          toolName: c.name ?? c.tool_name ?? "",
          toolCallId: c.id ?? c.tool_call_id ?? "",
          args: c.arguments ?? {},
        });
      }
    }
  }

  // If the turn errored with no other content, surface the error text in-band.
  if (msg.stopReason === "error" && msg.errorMessage && parts.length === 0) {
    parts.push({ type: "text", text: `⚠ ${msg.errorMessage}` });
  }

  return {
    role: msg.role,
    parts,
    timestamp: msg.timestamp ?? Date.now(),
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    isError: msg.isError || msg.stopReason === "error",
    stopReason: msg.stopReason,
    errorMessage: msg.errorMessage,
    usage: msg.usage,
    finalized: opts.finalized,
  };
}

/**
 * Decompose an assistant message's content blocks into a sequence of
 * wire events in live order: message events for text/thinking runs,
 * tool events for tool_use blocks.
 *
 * Returns an array of { type: "message" | "tool", payload: any } objects.
 */
function decomposeAssistantMessage(msg: any): Array<{ type: "message" | "tool"; payload: any }> {
  const content = msg.content;
  if (!Array.isArray(content)) {
    // Single string content — emit as a single message event
    const parts = content ? [{ type: "text", text: content }] : [];
    return [{ type: "message", payload: normalizeMessage(msg, { finalized: true }) }];
  }

  const events: Array<{ type: "message" | "tool"; payload: any }> = [];
  let textBuffer = "";
  let thinkingBuffer = "";

  const flushText = () => {
    if (textBuffer.trim()) {
      events.push({
        type: "message",
        payload: {
          ...normalizeMessage(msg, { finalized: true }),
          parts: [{ type: "text", text: textBuffer.trim() }],
        },
      });
      textBuffer = "";
    }
  };

  const flushThinking = () => {
    if (thinkingBuffer.trim()) {
      events.push({
        type: "message",
        payload: {
          ...normalizeMessage(msg, { finalized: true }),
          parts: [{ type: "thinking", text: thinkingBuffer.trim() }],
        },
      });
      thinkingBuffer = "";
    }
  };

  for (const c of content) {
    if (c.type === "text" && c.text) {
      textBuffer += c.text;
    } else if (c.type === "thinking" && c.thinking) {
      thinkingBuffer += c.thinking;
    } else if (c.type === "toolCall" || c.type === "tool_use") {
      // Flush any buffered text/thinking before the tool call
      flushText();
      flushThinking();
      events.push({
        type: "tool",
        payload: {
          sessionId: msg._sessionId ?? "",
          toolName: c.name ?? c.tool_name ?? "",
          toolCallId: c.id ?? c.tool_call_id ?? "",
          args: c.arguments ?? {},
          status: "end" as const,
        },
      });
    }
  }

  // Flush remaining buffers
  flushText();
  flushThinking();

  // If no events were produced (pure tool-use message with no text),
  // emit a minimal message event so the client has a container
  if (events.length === 0) {
    const parts = [];
    if (msg.stopReason === "error" && msg.errorMessage) {
      parts.push({ type: "text", text: `⚠ ${msg.errorMessage}` });
    }
    if (parts.length > 0) {
      events.push({
        type: "message",
        payload: {
          ...normalizeMessage(msg, { finalized: true }),
          parts,
        },
      });
    }
  }

  return events;
}

// ─── Broadcast helpers ──────────────────────────────────────────────────────

function sendToClient(client: Client, event: ServerEvent): void {
  if (client.readyState === WSWebSocket.OPEN) {
    client.send(JSON.stringify(event));
  }
}

function broadcastToSession(s: SessionState, event: ServerEvent): void {
  for (const c of s.clients) sendToClient(c, event);
}

function broadcastDriverUpdate(s: SessionState, extra: Partial<ServerEvent> = {}): void {
  broadcastToSession(s, {
    type: "session_update",
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    isStreaming: computeActivity(s),
    driver: s.driver,
    messageCount: s.knownEntryIds.size,
    ...extra,
  });
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

async function readSessionHeader(
  sessionFile: string,
): Promise<{ sessionId: string; cwd: string; name?: string }> {
  const data = await fs.promises.readFile(sessionFile, "utf8");
  const firstLine = data.split("\n", 1)[0];
  let header: any = {};
  try {
    header = JSON.parse(firstLine);
  } catch {
    // fall through with defaults
  }
  // Extract session name from latest session_info entry
  let name: string | undefined;
  const lines = data.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_info") {
        name = entry.name?.trim() || undefined;
        break;
      }
    } catch {
      // skip malformed
    }
  }
  return {
    sessionId: header.id ?? "",
    cwd: header.cwd ?? process.cwd(),
    name,
  };
}

async function getOrCreateSessionState(sessionFile: string): Promise<SessionState> {
  const existing = sessions.get(sessionFile);
  if (existing) return existing;
  const { sessionId, cwd, name } = await readSessionHeader(sessionFile);
  const stat = await fs.promises.stat(sessionFile);
  const data = await fs.promises.readFile(sessionFile, "utf8");
  const { entries, leftover } = parseJsonlChunk(data);
  const s: SessionState = {
    sessionFile,
    sessionId,
    cwd,
    sessionName: name,
    clients: new Set(),
    watcher: null,
    fileSize: stat.size,
    fileTail: leftover,
    knownEntryIds: new Set(entries.map((e) => e.id).filter(Boolean)),
    externalIdleTimer: null,
    idleReleaseTimer: null,
    agentSession: null,
    agentUnsubscribe: null,
    driver: "none",
  };
  s.watcher = startWatcher(s);
  sessions.set(sessionFile, s);
  slog(
    s,
    `📂 opened cwd=${cwd} entries=${s.knownEntryIds.size} file=${path.basename(sessionFile)}`,
  );
  return s;
}

function startWatcher(s: SessionState): fs.FSWatcher | null {
  let pending = false;
  const trigger = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      readNewEntries(s).catch((err) =>
        console.error(`[session ${s.sessionId}] watcher read failed:`, err),
      );
    }, 30);
  };
  try {
    const w = fs.watch(s.sessionFile, { persistent: false }, () => trigger());
    return w;
  } catch {
    // File doesn't exist yet — watcher will be started after first write
    return null;
  }
}

async function readNewEntries(s: SessionState): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(s.sessionFile);
  } catch {
    return;
  }
  if (stat.size === s.fileSize) return;
  if (stat.size < s.fileSize) {
    // File truncated/replaced — re-seed from scratch
    s.fileSize = 0;
    s.fileTail = "";
    s.knownEntryIds.clear();
  }
  const length = stat.size - s.fileSize;
  const fd = await fs.promises.open(s.sessionFile, "r");
  const buf = Buffer.alloc(length);
  await fd.read(buf, 0, length, s.fileSize);
  await fd.close();
  s.fileSize = stat.size;
  const combined = s.fileTail + buf.toString("utf8");
  const { entries, leftover } = parseJsonlChunk(combined);
  s.fileTail = leftover;

  let sawExternal = false;
  for (const e of entries) {
    if (!e.id || s.knownEntryIds.has(e.id)) continue;
    // If we own the session, check whether this entry was written by our AgentSession
    if (s.agentSession) {
      try {
        if (s.agentSession.sessionManager.getEntry(e.id)) {
          // Ours — agent's listener already broadcast it
          s.knownEntryIds.add(e.id);
          continue;
        }
      } catch {
        // fall through and treat as external
      }
    }
    s.knownEntryIds.add(e.id);
    sawExternal = true;
    if (e.type === "message") {
      broadcastToSession(s, {
        type: "message",
        sessionId: s.sessionId,
        message: normalizeMessage(e.raw.message ?? {}, { finalized: true }),
      });
    }
  }

  if (!sawExternal) return;

  if (s.driver === "self") {
    slog(s, "⚠ external write detected while we own — releasing");
    await releaseOwnership(s, "external write detected — pi-CLI took over");
  } else if (s.driver !== "external") {
    slog(s, "📝 external write — driver=external");
    s.driver = "external";
    broadcastDriverUpdate(s);
  }
  // Reset idle timer — flip back to "none" after quiet period
  if (s.externalIdleTimer) clearTimeout(s.externalIdleTimer);
  // Broadcast "working" immediately when timer is reset (new write detected)
  broadcastDriverUpdate(s);
  s.externalIdleTimer = setTimeout(() => {
    if (s.driver === "external") {
      s.driver = "none";
      broadcastDriverUpdate(s);
      // An externally-driven session that went idle with no viewers should also
      // be eligible for grace cleanup.
      if (s.clients.size === 0) scheduleIdleRelease(s);
    }
  }, 15_000);
}

// ─── Ownership transitions ──────────────────────────────────────────────────

async function takeOwnership(s: SessionState): Promise<void> {
  if (s.agentSession) return;
  await readNewEntries(s); // drain anything pending so we open with latest state
  const settingsManager = SettingsManager.create(s.cwd, AGENT_DIR);
  const resourceLoader = new DefaultResourceLoader({
    cwd: s.cwd,
    agentDir: AGENT_DIR,
    settingsManager,
  });
  await resourceLoader.reload();
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: s.cwd,
    agentDir: AGENT_DIR,
    sessionManager: SessionManager.open(s.sessionFile),
    settingsManager,
    resourceLoader,
  });
  s.agentSession = session;
  s.agentUnsubscribe = session.subscribe((event) => {
    try {
      handleAgentEvent(s, event);
    } catch (err) {
      slog(s, `✗ handleAgentEvent threw for event=${event.type}:`, err);
    }
  });
  s.driver = "self";
  if (s.externalIdleTimer) {
    clearTimeout(s.externalIdleTimer);
    s.externalIdleTimer = null;
  }
  // Seed knownEntryIds with everything the agent knows so far
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.id) s.knownEntryIds.add(entry.id);
  }
  broadcastDriverUpdate(s);
  const m = session.model;
  slog(
    s,
    `🎬 took ownership model=${m ? `${m.provider}/${m.id}` : "<none>"} thinking=${session.thinkingLevel} baseUrl=${m?.baseUrl ?? "?"} existingMessages=${session.messages.length}`,
  );
  if (modelFallbackMessage) slog(s, `   modelFallback: ${modelFallbackMessage}`);
}

async function releaseOwnership(s: SessionState, reasonMessage?: string): Promise<void> {
  if (!s.agentSession) return;
  try {
    s.agentUnsubscribe?.();
    await s.agentSession.abort();
    s.agentSession.dispose();
  } catch (err) {
    console.error(`[session ${s.sessionId}] release error:`, err);
  }
  s.agentSession = null;
  s.agentUnsubscribe = null;
  s.driver = "none";
  broadcastDriverUpdate(s);
  if (reasonMessage) {
    broadcastToSession(s, { type: "error", message: reasonMessage });
  }
  slog(s, `🛑 released ownership${reasonMessage ? ` (${reasonMessage})` : ""}`);
}

// ─── Agent event → wire event ───────────────────────────────────────────────

function handleAgentEvent(s: SessionState, event: AgentSessionEvent): void {
  const sessionId = s.sessionId;
  switch (event.type) {
    case "agent_start":
      slog(s, "▶ agent_start (LLM call beginning)");
      cancelIdleRelease(s);
      broadcastDriverUpdate(s, { isStreaming: true });
      break;

    case "agent_end": {
      const reason = (event as any).reason ?? "";
      slog(
        s,
        `⏹ agent_end${reason ? ` (${reason})` : ""} willRetry=${(event as any).willRetry ?? false} messages=${s.agentSession?.messages.length ?? 0}`,
      );
      broadcastDriverUpdate(s, { isStreaming: false, messageCount: s.agentSession?.messages.length ?? 0 });
      // Task finished. If nobody is watching, start the idle grace countdown.
      if (s.clients.size === 0) scheduleIdleRelease(s);
      break;
    }

    case "message_start": {
      const role = (event.message as any).role ?? "?";
      slog(s, `↳ message_start role=${role}`);
      broadcastToSession(s, {
        type: "message",
        sessionId,
        message: normalizeMessage(event.message, { finalized: false }),
      });
      break;
    }

    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        broadcastToSession(s, {
          type: "streaming",
          sessionId,
          delta: event.assistantMessageEvent.delta,
        });
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        broadcastToSession(s, {
          type: "streaming",
          sessionId,
          delta: event.assistantMessageEvent.delta,
          isThinking: true,
        });
      }
      break;

    case "message_end": {
      const m = event.message as any;
      const id = m.id;
      if (id) s.knownEntryIds.add(id);
      if (s.agentSession) {
        for (const entry of s.agentSession.sessionManager.getEntries()) {
          if (entry.id) s.knownEntryIds.add(entry.id);
        }
      }
      const role = m.role ?? "?";
      const stop = m.stopReason ? ` stop=${m.stopReason}` : "";
      const err = m.errorMessage ? ` err="${preview(m.errorMessage, 80)}"` : "";
      const tokens = m.usage
        ? ` tokens=${m.usage.input ?? 0}/${m.usage.output ?? 0}`
        : "";
      slog(s, `✓ message_end role=${role}${stop}${err}${tokens}`);
      broadcastToSession(s, {
        type: "message",
        sessionId,
        message: normalizeMessage(event.message, { finalized: true }),
      });
      break;
    }

    case "tool_execution_start":
      slog(s, `🔧 tool_start ${event.toolName}`);
      broadcastToSession(s, {
        type: "tool",
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args as Record<string, unknown>,
        status: "start",
      });
      break;

    case "tool_execution_update": {
      const partial =
        event.partialResult?.content
          ?.map((c: any) => (c.type === "text" ? c.text : ""))
          .join("") ?? "";
      broadcastToSession(s, {
        type: "tool",
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        status: "update",
        result: partial,
      });
      break;
    }

    case "tool_execution_end": {
      const text =
        event.result?.content
          ?.map((c: any) => (c.type === "text" ? c.text : ""))
          .join("") ?? "";
      slog(
        s,
        `🔧 tool_end ${event.toolName} ${event.isError ? "ERROR" : "ok"} (${text.length} chars)`,
      );
      broadcastToSession(s, {
        type: "tool",
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        status: "end",
        result: text,
        isError: event.isError,
      });
      break;
    }

    case "queue_update":
      broadcastToSession(s, {
        type: "queue_update",
        sessionId,
        steering: event.steering ?? [],
        followUp: event.followUp ?? [],
      });
      break;

    case "compaction_start":
      slog(s, "📦 compaction_start");
      broadcastToSession(s, { type: "compaction", sessionId, phase: "start" });
      break;

    case "compaction_end":
      slog(s, "📦 compaction_end");
      broadcastToSession(s, {
        type: "compaction",
        sessionId,
        phase: "end",
        summary: event.result?.summary,
      });
      break;

    case "auto_retry_start":
      slog(
        s,
        `⟳ auto_retry attempt ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s — ${event.errorMessage}`,
      );
      broadcastToSession(s, {
        type: "error",
        message: `Retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`,
      });
      break;

    case "auto_retry_end":
      slog(
        s,
        `⟳ auto_retry ${event.success ? "succeeded" : "failed"} after ${event.attempt} attempts${event.finalError ? ` — ${event.finalError}` : ""}`,
      );
      if (!event.success) {
        broadcastToSession(s, {
          type: "error",
          message: `Auto-retry gave up after ${event.attempt} attempts${event.finalError ? `: ${event.finalError}` : ""}`,
        });
      }
      break;
  }
}

// ─── Token stats aggregation ────────────────────────────────────────────────

// Extract the program name from a bash command line for activity breakdown.
// Skips leading `VAR=value` env assignments and reduces a path to its basename,
// so `/usr/bin/git`, `./git`, and `FOO=1 git` all read as "git".
function bashSubcommand(command: string): string | null {
  if (!command) return null;
  let cmd = command.trim();
  // Unwrap leading `cd <dir> &&` / `cd <dir>;` prefixes so we report the real
  // command being run rather than the directory change in front of it.
  while (/^cd\s+\S+\s*(&&|;)\s*/.test(cmd)) {
    cmd = cmd.replace(/^cd\s+\S+\s*(&&|;)\s*/, "");
  }
  const tokens = cmd.split(/\s+/);
  let i = 0;
  // Skip leading VAR=value env assignments.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  let tok = tokens[i];
  if (!tok) return null;
  // Strip a leading call operator / opening quote and any trailing quote.
  tok = tok.replace(/^[&("']+/, "").replace(/["']+$/, "");
  // Reduce a path to its basename so /usr/bin/git and ./git both read as "git".
  tok = tok.split(/[\\/]/).pop() || tok;
  // Normalize Windows executables: powershell.exe -> powershell.
  tok = tok.replace(/\.exe$/i, "");
  return tok || null;
}

interface DayTokens {
  input: number;
  output: number;
  cache: number;
}

interface HourTokens {
  input: number;
  output: number;
  cache: number;
}

async function aggregateTokenStats(): Promise<{
  byHour: Record<string, HourTokens>;
  byDay: Record<string, DayTokens>;
  byWeek: Record<string, DayTokens>;
  totalMessages: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  totalErrors: number;
  toolCalls: Record<string, number>;
}> {
  const byHour = new Map<string, HourTokens>();
  const byDay = new Map<string, DayTokens>();
  const byWeek = new Map<string, DayTokens>();
  let totalMessages = 0;
  let totalUserMessages = 0;
  let totalAssistantMessages = 0;
  let totalErrors = 0;
  const toolCalls = new Map<string, number>();

  try {
    const list = await SessionManager.listAll();
    for (const s of list) {
      const filePath = s.path;
      if (!filePath) continue;
      const data = fs.readFileSync(filePath, "utf8");
      const lines = data.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry.type !== "message") continue;
          const msg = entry.message ?? entry;
          totalMessages++;
          if (msg.role === "user") totalUserMessages++;
          else if (msg.role === "assistant") {
            totalAssistantMessages++;
            const content = msg.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === "toolCall" || c.type === "tool_use") {
                  const toolName = c.name ?? c.tool_name ?? "unknown";
                  // Break bash down by the leading command (e.g. "bash: git")
                  // so the activity view shows what's actually being run.
                  let key = toolName;
                  if (toolName === "bash") {
                    const args = c.arguments ?? c.args ?? c.input ?? {};
                    const cmd = typeof args.command === "string" ? args.command
                      : typeof args.cmd === "string" ? args.cmd : "";
                    const sub = bashSubcommand(cmd);
                    key = sub ? `bash: ${sub}` : "bash";
                  }
                  toolCalls.set(key, (toolCalls.get(key) ?? 0) + 1);
                }
              }
            }
            if (msg.stopReason === "error" || msg.isError) totalErrors++;
          }
          const usage = msg.usage;
          if (!usage) continue;
          const ts = msg.timestamp ?? Date.now();
          const d = new Date(ts);

          // Hour key: "YYYY-MM-DD HH"
          const hourKey = d.getFullYear() + "-" +
            String(d.getMonth() + 1).padStart(2, "0") + "-" +
            String(d.getDate()).padStart(2, "0") + " " +
            String(d.getHours()).padStart(2, "0");
          // Day key: "YYYY-MM-DD"
          const dayKey = d.getFullYear() + "-" +
            String(d.getMonth() + 1).padStart(2, "0") + "-" +
            String(d.getDate()).padStart(2, "0");
          // Week key: "YYYY-Www"
          const weekKey = getISOWeekKey(d);

          // Hour
          if (!byHour.has(hourKey)) byHour.set(hourKey, { input: 0, output: 0, cache: 0 });
          const hTok = byHour.get(hourKey)!;
          hTok.input += usage.input ?? 0;
          hTok.output += usage.output ?? 0;
          hTok.cache += (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

          // Day
          if (!byDay.has(dayKey)) byDay.set(dayKey, { input: 0, output: 0, cache: 0 });
          const dTok = byDay.get(dayKey)!;
          dTok.input += usage.input ?? 0;
          dTok.output += usage.output ?? 0;
          dTok.cache += (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

          // Week
          if (!byWeek.has(weekKey)) byWeek.set(weekKey, { input: 0, output: 0, cache: 0 });
          const wTok = byWeek.get(weekKey)!;
          wTok.input += usage.input ?? 0;
          wTok.output += usage.output ?? 0;
          wTok.cache += (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        } catch {
          // skip malformed lines
        }
      }
    }
  } catch (err) {
    console.error("[token_stats] error aggregating:", err);
  }

  return {
    byHour: Object.fromEntries(byHour),
    byDay: Object.fromEntries(byDay),
    byWeek: Object.fromEntries(byWeek),
    totalMessages,
    totalUserMessages,
    totalAssistantMessages,
    totalErrors,
    toolCalls: Object.fromEntries(toolCalls),
  };
}

function getISOWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + "-W" + String(weekNo).padStart(2, "0");
}

// ─── Per-client commands ────────────────────────────────────────────────────

async function listSessions(client: Client): Promise<void> {
  try {
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THREE_DAYS_MS;
    const list = await SessionManager.listAll();
    const out: SessionInfo[] = list
      .filter((s: any) => {
        const modTime = s.modified instanceof Date ? s.modified.getTime() : new Date(s.modified).getTime();
        return modTime >= cutoff;
      })
      .map((s: any) => ({
        file: s.path ?? "",
        id: s.id ?? "",
        name: s.name,
        cwd: s.cwd ?? "",
        firstMessage: s.firstMessage,
        entryCount: s.messageCount ?? 0,
        timestamp: s.modified instanceof Date ? s.modified.getTime() : new Date(s.modified).getTime(),
      }));
    sendToClient(client, { type: "session_list", sessions: out });
  } catch (err) {
    sendToClient(client, {
      type: "error",
      message: err instanceof Error ? err.message : "Failed to list sessions",
    });
  }
}

async function connectSession(client: Client, sessionFile: string): Promise<void> {
  if (client.subscribedSessionFile) await detachClient(client);
  const s = await getOrCreateSessionState(sessionFile);
  client.subscribedSessionFile = sessionFile;
  s.clients.add(client);
  cancelIdleRelease(s);
  sendToClient(client, {
    type: "session_update",
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    sessionName: s.sessionName,
    isStreaming: computeActivity(s),
    driver: s.driver,
    messageCount: s.knownEntryIds.size,
    clientSessionId: s.sessionId,
  });
  // Replay all on-disk message entries to the connecting client
  const data = await fs.promises.readFile(sessionFile, "utf8");
  sendToClient(client, { type: "replay_start", sessionId: s.sessionId });
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type !== "message") continue;

      const msg = entry.message ?? {};
      if (msg.role === "user") {
        // User message — emit as a single message event with text parts
        const wireMsg = normalizeMessage(msg, { finalized: true });
        if (wireMsg.parts.length > 0) {
          sendToClient(client, { type: "message", sessionId: s.sessionId, message: wireMsg });
        }
      } else if (msg.role === "assistant") {
        // Walk content blocks in order, emit message events for text/thinking
        // and tool events for tool_use blocks
        const decomposed = decomposeAssistantMessage(msg);
        for (const ev of decomposed) {
          if (ev.type === "message") {
            sendToClient(client, { type: "message", sessionId: s.sessionId, message: ev.payload });
          } else if (ev.type === "tool") {
            // sessionId must win over ev.payload's (which is "" from decompose),
            // or the client's clientSessionId guard drops these args-bearing events.
            sendToClient(client, { type: "tool", ...ev.payload, sessionId: s.sessionId });
          }
        }
      } else if (msg.role === "toolResult" || msg.role === "tool") {
        // Tool result — emit a tool event with status: "end"
        sendToClient(client, {
          type: "tool",
          sessionId: s.sessionId,
          toolName: msg.toolName ?? "",
          toolCallId: msg.toolCallId ?? "",
          status: "end" as const,
          result: stringifyToolResultContent(msg.content),
          isError: msg.isError,
        });
      }
    } catch {
      // skip malformed lines
    }
  }
  sendToClient(client, { type: "replay_end", sessionId: s.sessionId });
}

// How long an idle, viewer-less session stays alive before it's torn down.
// A session that is actively working is never torn down by this timer.
const IDLE_RELEASE_MS = 15 * 60 * 1000;

// Fully tear down a session: release ownership, stop watching, drop from the map.
// The on-disk session file is untouched, so it can be reopened later.
async function teardownSession(s: SessionState): Promise<void> {
  if (s.idleReleaseTimer) {
    clearTimeout(s.idleReleaseTimer);
    s.idleReleaseTimer = null;
  }
  if (s.agentSession) await releaseOwnership(s);
  if (s.externalIdleTimer) clearTimeout(s.externalIdleTimer);
  s.watcher?.close();
  sessions.delete(s.sessionFile);
  console.log(`[session ${s.sessionId}] torn down (no viewers, idle)`);
}

function cancelIdleRelease(s: SessionState): void {
  if (s.idleReleaseTimer) {
    clearTimeout(s.idleReleaseTimer);
    s.idleReleaseTimer = null;
  }
}

// Arm the grace timer for a viewer-less, idle session. When it fires we re-check
// that the session is still viewer-less and idle before tearing it down, so a
// reconnect or a freshly-started task cancels the teardown.
function scheduleIdleRelease(s: SessionState): void {
  cancelIdleRelease(s);
  s.idleReleaseTimer = setTimeout(() => {
    s.idleReleaseTimer = null;
    if (s.clients.size === 0 && !computeActivity(s)) {
      void teardownSession(s);
    }
  }, IDLE_RELEASE_MS);
}

async function detachClient(client: Client): Promise<void> {
  const sf = client.subscribedSessionFile;
  if (!sf) return;
  client.subscribedSessionFile = null;
  const s = sessions.get(sf);
  if (!s) return;
  s.clients.delete(client);
  if (s.clients.size === 0) {
    // Keep the session alive so a running task survives a closed browser/phone.
    // If it's idle, start the grace timer; if it's working, leave it — the
    // timer is (re)armed when the task finishes (see handleAgentEvent agent_end).
    if (computeActivity(s)) {
      console.log(`[session ${s.sessionId}] last viewer left — task still running, keeping alive`);
    } else {
      console.log(`[session ${s.sessionId}] last viewer left — idle, releasing in ${IDLE_RELEASE_MS / 60000}min`);
      scheduleIdleRelease(s);
    }
  }
}

async function handlePrompt(
  client: Client,
  message: string,
  streamingBehavior?: "steer" | "followUp",
): Promise<void> {
  const sf = client.subscribedSessionFile;
  if (!sf) {
    sendToClient(client, { type: "error", message: "No session selected" });
    return;
  }
  const s = sessions.get(sf);
  if (!s) {
    sendToClient(client, { type: "error", message: "Session not found" });
    return;
  }
  slog(
    s,
    `📨 prompt from ${client.clientId} (${message.length} chars${streamingBehavior ? `, ${streamingBehavior}` : ""}): "${preview(message)}"`,
  );
  const t0 = Date.now();
  try {
    if (!s.agentSession) await takeOwnership(s);
    slog(s, `→ calling AgentSession.prompt() (isStreaming=${s.agentSession!.isStreaming})`);
    await s.agentSession!.prompt(message, { streamingBehavior });
    slog(s, `✓ prompt() returned after ${Date.now() - t0}ms`);
  } catch (err) {
    slog(s, `✗ prompt failed after ${Date.now() - t0}ms:`, err);
    sendToClient(client, {
      type: "error",
      message: err instanceof Error ? err.message : "Failed to send prompt",
    });
  }
}

async function handleAbort(client: Client): Promise<void> {
  const sf = client.subscribedSessionFile;
  if (!sf) return;
  const s = sessions.get(sf);
  if (!s?.agentSession) return;
  await s.agentSession.abort();
}

async function handleRelease(client: Client): Promise<void> {
  const sf = client.subscribedSessionFile;
  if (!sf) return;
  const s = sessions.get(sf);
  if (!s) return;
  if (s.agentSession) await releaseOwnership(s);
}

async function handleNewSession(client: Client, requestedCwd?: string): Promise<void> {
  try {
    if (client.subscribedSessionFile) await detachClient(client);
    let cwd = process.cwd();
    if (requestedCwd && requestedCwd.trim()) {
      const candidate = path.resolve(requestedCwd.trim());
      try {
        if (!(await fs.promises.stat(candidate)).isDirectory()) {
          sendToClient(client, { type: "error", message: `Not a directory: ${candidate}` });
          return;
        }
      } catch {
        sendToClient(client, { type: "error", message: `Directory not found: ${candidate}` });
        return;
      }
      cwd = candidate;
    }
    const settingsManager = SettingsManager.create(cwd, AGENT_DIR);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: AGENT_DIR,
      settingsManager,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: AGENT_DIR,
      sessionManager: SessionManager.create(cwd),
      settingsManager,
      resourceLoader,
    });
    const sessionFile = session.sessionFile ?? "";
    if (!sessionFile) {
      sendToClient(client, { type: "error", message: "New session has no file" });
      session.dispose();
      return;
    }
    const s: SessionState = {
      sessionFile,
      sessionId: session.sessionId,
      cwd,
      sessionName: undefined,
      clients: new Set([client]),
      watcher: null,
      fileSize: 0,
      fileTail: "",
      knownEntryIds: new Set(),
      externalIdleTimer: null,
      idleReleaseTimer: null,
      agentSession: session,
      agentUnsubscribe: null,
      driver: "self",
    };
    s.agentUnsubscribe = session.subscribe((event) => {
      try {
        handleAgentEvent(s, event);
      } catch (err) {
        slog(s, `✗ handleAgentEvent threw for event=${event.type}:`, err);
      }
    });
    try {
      const stat = await fs.promises.stat(sessionFile);
      s.fileSize = stat.size;
    } catch {
      // file may not exist yet — fileSize stays 0
    }
    s.watcher = startWatcher(s);
    sessions.set(sessionFile, s);
    client.subscribedSessionFile = sessionFile;
    sendToClient(client, {
      type: "session_update",
      sessionId: s.sessionId,
      sessionFile,
      isStreaming: false,
      driver: "self",
      messageCount: 0,
      clientSessionId: s.sessionId,
      cwd,
    });
  } catch (err) {
    console.error("[handleNewSession] error:", err);
    sendToClient(client, {
      type: "error",
      message: err instanceof Error ? err.message : "Failed to create session",
    });
  }
}

async function handleSetSessionName(client: Client, name: string): Promise<void> {
  const sf = client.subscribedSessionFile;
  if (!sf) return;
  const s = sessions.get(sf);
  if (!s) return;
  if (s.agentSession) {
    try {
      s.agentSession.setSessionName(name);
    } catch (err) {
      console.error(`[session ${s.sessionId}] setSessionName error:`, err);
    }
  }
  broadcastDriverUpdate(s, { sessionName: name });
}

// ─── WS dispatcher ──────────────────────────────────────────────────────────

async function handleCommand(client: Client, command: ClientCommand): Promise<void> {
  switch (command.type) {
    case "list_sessions":
      await listSessions(client);
      break;
    case "connect_session":
      await connectSession(client, (command as any).sessionFile);
      break;
    case "disconnect_session":
      await detachClient(client);
      break;
    case "prompt":
      await handlePrompt(
        client,
        (command as any).message,
        (command as any).streamingBehavior,
      );
      break;
    case "abort":
      await handleAbort(client);
      break;
    case "release_session":
      await handleRelease(client);
      break;
    case "new_session":
      await handleNewSession(client, (command as any).cwd);
      break;
    case "set_session_name":
      await handleSetSessionName(client, (command as any).name);
      break;
    case "get_state":
    case "get_messages":
      // No-op: server pushes state via session_update + message events
      break;
    case "get_token_stats": {
      const stats = await aggregateTokenStats();
      const hourStats: Record<string, TokenDayStats> = {};
      for (const [k, v] of Object.entries(stats.byHour)) {
        hourStats[k] = v as TokenDayStats;
      }
      const dayStats: Record<string, TokenDayStats> = {};
      for (const [k, v] of Object.entries(stats.byDay)) {
        dayStats[k] = v as TokenDayStats;
      }
      const weekStats: Record<string, TokenDayStats> = {};
      for (const [k, v] of Object.entries(stats.byWeek)) {
        weekStats[k] = v as TokenDayStats;
      }
      sendToClient(client, {
        type: "token_stats",
        byHour: hourStats,
        byDay: dayStats,
        byWeek: weekStats,
        totalMessages: stats.totalMessages,
        totalUserMessages: stats.totalUserMessages,
        totalAssistantMessages: stats.totalAssistantMessages,
        totalErrors: stats.totalErrors,
        toolCalls: stats.toolCalls,
      });
      break;
    }
    default:
      sendToClient(client, {
        type: "error",
        message: `Unknown command: ${command.type}`,
      });
  }
}

// ─── HTTP + WS bootstrap ────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT ?? 3456;
app.use(express.static(path.join(__dirname, "..", "public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws: Client) => {
  ws.clientId = `client-${++clientIdCounter}`;
  ws.subscribedSessionFile = null;
  clients.add(ws);
  console.log(`Client connected: ${ws.clientId} (${clients.size} total)`);

  ws.on("message", async (data) => {
    let command: ClientCommand;
    try {
      command = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }
    console.log(`${ts()} [${ws.clientId}] ◀ ${command.type}`);
    try {
      await handleCommand(ws, command);
    } catch (err) {
      console.error("[handleCommand]", err);
      sendToClient(ws, {
        type: "error",
        message: err instanceof Error ? err.message : "Command failed",
      });
    }
  });

  ws.on("close", async () => {
    await detachClient(ws);
    clients.delete(ws);
    console.log(`Client disconnected: ${ws.clientId} (${clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🚀 web-pi running at http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  for (const [, s] of sessions) {
    if (s.agentSession) {
      try {
        await s.agentSession.abort();
        s.agentSession.dispose();
      } catch {
        // ignore
      }
    }
    if (s.externalIdleTimer) clearTimeout(s.externalIdleTimer);
    s.watcher?.close();
  }
  wss.close();
  httpServer.close();
  process.exit(0);
});
