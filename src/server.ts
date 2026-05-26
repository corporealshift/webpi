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
import type { ClientCommand, SessionInfo, ServerEvent } from "./types.js";

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
  clients: Set<Client>;
  // File-watch state
  watcher: fs.FSWatcher | null;
  fileSize: number;
  fileTail: string;
  knownEntryIds: Set<string>;
  externalIdleTimer: NodeJS.Timeout | null;
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

function entryToWireMessage(entry: any): any {
  const msg = entry.message ?? {};
  return normalizeMessage(msg, { finalized: true });
}

function normalizeMessage(msg: any, opts: { finalized: boolean }): any {
  const content = msg.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return {
    role: msg.role,
    content: text,
    timestamp: msg.timestamp ?? Date.now(),
    toolCallId: msg.toolCallId,
    toolName: msg.toolName,
    isError: msg.isError,
    stopReason: msg.stopReason,
    usage: msg.usage,
    finalized: opts.finalized,
  };
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
    isStreaming: !!s.agentSession?.isStreaming,
    driver: s.driver,
    messageCount: s.knownEntryIds.size,
    ...extra,
  });
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

async function readSessionHeader(
  sessionFile: string,
): Promise<{ sessionId: string; cwd: string }> {
  const data = await fs.promises.readFile(sessionFile, "utf8");
  const firstLine = data.split("\n", 1)[0];
  let header: any = {};
  try {
    header = JSON.parse(firstLine);
  } catch {
    // fall through with defaults
  }
  return {
    sessionId: header.id ?? "",
    cwd: header.cwd ?? process.cwd(),
  };
}

async function getOrCreateSessionState(sessionFile: string): Promise<SessionState> {
  const existing = sessions.get(sessionFile);
  if (existing) return existing;
  const { sessionId, cwd } = await readSessionHeader(sessionFile);
  const stat = await fs.promises.stat(sessionFile);
  const data = await fs.promises.readFile(sessionFile, "utf8");
  const { entries, leftover } = parseJsonlChunk(data);
  const s: SessionState = {
    sessionFile,
    sessionId,
    cwd,
    clients: new Set(),
    watcher: null,
    fileSize: stat.size,
    fileTail: leftover,
    knownEntryIds: new Set(entries.map((e) => e.id).filter(Boolean)),
    externalIdleTimer: null,
    agentSession: null,
    agentUnsubscribe: null,
    driver: "none",
  };
  s.watcher = startWatcher(s);
  sessions.set(sessionFile, s);
  console.log(
    `[session ${sessionId}] opened sessionFile=${sessionFile} cwd=${cwd} entries=${s.knownEntryIds.size}`,
  );
  return s;
}

function startWatcher(s: SessionState): fs.FSWatcher {
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
  const w = fs.watch(s.sessionFile, { persistent: false }, () => trigger());
  return w;
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
        message: entryToWireMessage(e.raw),
      });
    }
  }

  if (!sawExternal) return;

  if (s.driver === "self") {
    console.warn(
      `[session ${s.sessionId}] external write detected while owner — releasing ownership`,
    );
    await releaseOwnership(s, "external write detected — pi-CLI took over");
  } else if (s.driver !== "external") {
    s.driver = "external";
    broadcastDriverUpdate(s);
  }
  // Reset idle timer — flip back to "none" after quiet period
  if (s.externalIdleTimer) clearTimeout(s.externalIdleTimer);
  s.externalIdleTimer = setTimeout(() => {
    if (s.driver === "external") {
      s.driver = "none";
      broadcastDriverUpdate(s);
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
  const { session } = await createAgentSession({
    cwd: s.cwd,
    agentDir: AGENT_DIR,
    sessionManager: SessionManager.open(s.sessionFile),
    settingsManager,
    resourceLoader,
  });
  s.agentSession = session;
  s.agentUnsubscribe = session.subscribe((event) => handleAgentEvent(s, event));
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
  console.log(`[session ${s.sessionId}] took ownership`);
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
  console.log(`[session ${s.sessionId}] released ownership`);
}

// ─── Agent event → wire event ───────────────────────────────────────────────

function handleAgentEvent(s: SessionState, event: AgentSessionEvent): void {
  const sessionId = s.sessionId;
  switch (event.type) {
    case "agent_start":
      broadcastToSession(s, {
        type: "session_update",
        sessionId,
        isStreaming: true,
        driver: s.driver,
      });
      break;

    case "agent_end":
      broadcastToSession(s, {
        type: "session_update",
        sessionId,
        isStreaming: false,
        driver: s.driver,
        messageCount: s.agentSession?.messages.length ?? 0,
      });
      break;

    case "message_start":
      broadcastToSession(s, {
        type: "message",
        sessionId,
        message: normalizeMessage(event.message, { finalized: false }),
      });
      break;

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
      const id = (event.message as any).id;
      if (id) s.knownEntryIds.add(id);
      // Catch up by syncing known IDs from the session manager (the message persisted
      // by the agent right after this listener returns will be picked up here too on
      // the next pass, but we also pre-seed via session manager entries below).
      if (s.agentSession) {
        for (const entry of s.agentSession.sessionManager.getEntries()) {
          if (entry.id) s.knownEntryIds.add(entry.id);
        }
      }
      broadcastToSession(s, {
        type: "message",
        sessionId,
        message: normalizeMessage(event.message, { finalized: true }),
      });
      break;
    }

    case "tool_execution_start":
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
      broadcastToSession(s, { type: "compaction", sessionId, phase: "start" });
      break;

    case "compaction_end":
      broadcastToSession(s, {
        type: "compaction",
        sessionId,
        phase: "end",
        summary: event.result?.summary,
      });
      break;
  }
}

// ─── Per-client commands ────────────────────────────────────────────────────

async function listSessions(client: Client): Promise<void> {
  try {
    const list = await SessionManager.list(process.cwd());
    const out: SessionInfo[] = list.map((s: any) => ({
      file: s.path ?? s.file ?? "",
      id: s.id ?? "",
      name: s.name,
      entryCount: s.messageCount ?? s.entryCount ?? 0,
      timestamp: s.modified ? new Date(s.modified).getTime() : (s.timestamp ?? 0),
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
  sendToClient(client, {
    type: "session_update",
    sessionId: s.sessionId,
    sessionFile: s.sessionFile,
    isStreaming: !!s.agentSession?.isStreaming,
    driver: s.driver,
    messageCount: s.knownEntryIds.size,
    clientSessionId: s.sessionId,
  });
  // Replay all on-disk message entries to the connecting client
  const data = await fs.promises.readFile(sessionFile, "utf8");
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type !== "message") continue;
      sendToClient(client, {
        type: "message",
        sessionId: s.sessionId,
        message: entryToWireMessage(entry),
      });
    } catch {
      // skip malformed lines
    }
  }
}

async function detachClient(client: Client): Promise<void> {
  const sf = client.subscribedSessionFile;
  if (!sf) return;
  client.subscribedSessionFile = null;
  const s = sessions.get(sf);
  if (!s) return;
  s.clients.delete(client);
  if (s.clients.size === 0) {
    if (s.agentSession) await releaseOwnership(s);
    if (s.externalIdleTimer) clearTimeout(s.externalIdleTimer);
    s.watcher?.close();
    sessions.delete(sf);
    console.log(`[session ${s.sessionId}] closed (no viewers)`);
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
  try {
    if (!s.agentSession) await takeOwnership(s);
    await s.agentSession!.prompt(message, { streamingBehavior });
  } catch (err) {
    console.error(`[session ${s.sessionId}] prompt error:`, err);
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

async function handleNewSession(client: Client): Promise<void> {
  try {
    if (client.subscribedSessionFile) await detachClient(client);
    const cwd = process.cwd();
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
      clients: new Set([client]),
      watcher: null,
      fileSize: 0,
      fileTail: "",
      knownEntryIds: new Set(),
      externalIdleTimer: null,
      agentSession: session,
      agentUnsubscribe: null,
      driver: "self",
    };
    s.agentUnsubscribe = session.subscribe((event) => handleAgentEvent(s, event));
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
      await handleNewSession(client);
      break;
    case "set_session_name":
      await handleSetSessionName(client, (command as any).name);
      break;
    case "get_state":
    case "get_messages":
      // No-op: server pushes state via session_update + message events
      break;
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
