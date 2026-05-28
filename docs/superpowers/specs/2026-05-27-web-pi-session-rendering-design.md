# Web PI Session Rendering & Activity Signal Design

| Field | Value |
|---|---|
| **Date** | 2026-05-27 |
| **Author** | Kyle |
| **Status** | Approved, ready for implementation |
| **Scope** | Server replay fidelity, activity signal correctness, client rendering, surface chrome |

---

## Motivation

Two failure modes currently degrade the user experience:

1. **Reopened sessions render badly.** On session connect, the server replays only `entry.type === "message"` entries from the JSONL log and collapses each message's content array to a plain text string via `normalizeMessage` (`server.ts:106`). This drops all tool calls (both `tool_use` content blocks in assistant messages and the companion `role: "tool"` result entries), all thinking content (only inline `<thinking>...</thinking>` tags in plain text are recognized client-side), and any assistant turn that was pure tool-use (which renders as an empty bubble).

2. **The working/idle indicator lies.** It is derived from `s.agentSession?.isStreaming`. When another process (pi-CLI) is driving the session, `agentSession` is null on the server side; `isStreaming` is therefore always false even while external writes are in progress. The driver pill correctly says "pi-cli driving" while the status text says "Idle" — two contradicting signals.

Three smaller requests accompany these:

- A persistent surface for connection status and session-list freshness.
- Per-message timestamps.
- Enter should not send the message; only the send button should.

---

## Goals

- Reopening any session shows the same content the user saw live: text, thinking, tool calls (with results), in chronological order, with no empty bubbles.
- The working/idle indicator reflects what is actually happening — whether the session is driven by this server or by an external pi-CLI process.
- The user can see at a glance whether the WebSocket is connected and when the session list was last refreshed, and can refresh it on demand.
- Every message (text bubble, tool-call card, thinking block) shows the time it was processed.
- Enter in the input box inserts a newline; only clicking the send button sends.

## Non-Goals

- Editing or re-running historical messages.
- Visual redesign of the activity indicator itself (current style stays; only its correctness changes).
- Real-time streaming-token visibility for externally driven sessions (the file watcher only sees complete JSONL entries; we are not parsing partial writes).
- Authentication, multi-user, or any access-control changes.

---

## Section 1 — Server: Full-Fidelity Replay + Correct Activity Signal

### Structured Wire Shape for Messages

Rewrite `normalizeMessage` (`server.ts:106`) to preserve message structure instead of joining text into a single string. The output shape becomes:

```typescript
{
  role: "user" | "assistant",
  parts: [
    { type: "text", text: string },
    { type: "thinking", text: string },
  ],
  timestamp: number,
  finalized: boolean,
  // preserved as today:
  stopReason?: string,
  errorMessage?: string,
  usage?: object,
  isError?: boolean
}
```

Key rules:

- **Decompose assistant messages to match live event order.** An assistant turn on disk can contain interleaved `text`, `thinking`, and `tool_use` content blocks. The live path emits `message` (text/thinking) and `tool` (tool calls) as **separate wire events**, in the order they happened. Historical replay must do the same: for each assistant entry, walk its content blocks in order and emit a series of events — a `message` event for the run of text/thinking blocks, and a `tool` event with `status: "end"` for each `tool_use` block. Never put `tool_use` inside `parts`. This guarantees identical DOM hierarchy whether the conversation was streamed live or replayed from disk.
- For `role: "tool"` entries (tool results), emit a `tool` wire event with `status: "end"` (or merge into the existing tool card by `toolCallId` — the client handles either) so they render through the same collapsed tool-card UI as live tool events.
- Drop emitted `message` events whose `parts` array is empty — these are the source of empty bubbles.
- For error stops with no other content, keep the existing behavior of surfacing the error message as a text part (today's `⚠ {errorMessage}` fallback).

### Full-Fidelity Replay in `connectSession` (`server.ts:593`)

Walk the JSONL in order. For each parsed entry, route by type:

- `type === "message"`, `role: "user"` → emit a single `message` event with text parts.
- `type === "message"`, `role: "assistant"` → walk content blocks in order, emitting `message` events for text/thinking and `tool` events (`status: "end"`) for each `tool_use` block (see decomposition rule above).
- `type === "message"`, `role: "tool"` → emit a `tool` event with `status: "end"` carrying `toolCallId`, `toolName`, and `result` text. If a tool card with the same `toolCallId` already exists on the client (from a prior `tool_use` block), the client merges the result into it.
- Other entry types (e.g. `session_info`) → skip.

Wrap the replay in two new wire events:

```typescript
{ type: "replay_start", sessionId: string }
// ... message / tool events ...
{ type: "replay_end", sessionId: string }
```

The client uses these to:

- (a) Defer scroll-to-bottom until `replay_end`.
- (b) Show and clear a "loading history" affordance.
- (c) Avoid running the streaming delta path on replayed assistant entries (everything in the replay batch is already `finalized: true`).

### Activity Signal

Add a helper to `server.ts`:

```typescript
function computeActivity(s: SessionState): boolean {
  if (s.driver === "self") return !!s.agentSession?.isStreaming;
  if (s.driver === "external") return s.externalIdleTimer !== null;
  return false;
}
```

The 15-second idle timer in `readNewEntries` (`server.ts:309`) becomes the external-activity heartbeat: a file write extends the timer (which means `activity = working`); 15 seconds of quiet fires the timer (which means `activity = idle`).

Use `computeActivity(s)` for the `isStreaming` field in:

- `broadcastDriverUpdate` (`server.ts:147`).
- The per-client `session_update` reply at the end of `connectSession` (`server.ts:598`).
- The `agent_start`/`agent_end` broadcasts in `handleAgentEvent` (`server.ts:386`, `396`) — currently they hard-code true/false, which is correct for self-driven sessions but is what we want centralized via the helper anyway.

Additionally, when the external idle timer fires (`server.ts:309`) and when it is reset, broadcast a fresh `session_update` so the client transitions to/from "working" without waiting for the next message to arrive.

---

## Section 2 — Client: Unified Renderer + Timestamps + Name Fix

### Unified `renderEntry`

Replace the two divergent code paths (`renderMessage` + `appendToAssistant` for messages at `index.html:992`/`1051`; `renderToolEvent` for tools at `index.html:1113`) with a single `renderEntry(entry)` that handles any incoming structured entry. Each part type gets its own helper:

- `renderTextPart(text)` — bubble div with `formatText` markdown.
- `renderThinkingPart(text)` — existing `.thinking-block` UI.

Tool calls do not appear inside `renderEntry`; they arrive as their own `tool` events (live or replayed) and continue to be rendered by the existing tool-card renderer (`renderToolEvent`, `index.html:1113`). The only change needed there is to accept a `status: "end"` event for a `toolCallId` it hasn't seen before — i.e. create the card on demand instead of requiring a prior `start`. This handles both replay (no prior start) and out-of-order live events.

The streaming-delta path (`appendStreamingDelta`, `index.html:1013`) keeps the text-node-mutation optimization. It finds the in-flight assistant entry and appends to the last text part's DOM text node. No change to the per-token cost.

### Replay Handling

- On `replay_start`: set `state.replaying = true`, hide streaming-related affordances, and skip auto-scroll.
- On each replayed event: call `renderEntry` (no streaming behavior).
- On `replay_end`: set `state.replaying = false` and scroll-to-bottom once.

### No Empty Bubbles

`renderEntry` checks: if `entry.parts` is empty (or all parts are empty strings), return without appending DOM. The server-side filter already removes most of these; this is a belt-and-suspenders guard.

### Per-Message Timestamp

Add `<div class="message-time">` under each bubble, each tool-call card, and each thinking block. Format `h:mm a` (12-hour). Source: `msg.timestamp` (already on the wire). CSS: muted color, ~11px, right-aligned for user messages and left-aligned for assistant/tool.

### Session-Name Fix

Extract `pickDisplayName(s)`:

1. `s.name` if set,
2. else `s.firstMessage` trimmed to 60 chars + ellipsis,
3. else "New session".

Both the sidebar item rendering (`index.html:938`) and the chat-header rendering (currently inline at `index.html:833` and `index.html:978`) use this helper. The chat-header also re-renders when `session_update.sessionName` arrives.

---

## Section 3 — Surface Chrome

### Sidebar Footer

Add a small persistent strip at the bottom of `#session-list`:

```
[● Connected]   [Updated 3:42 PM]   [↻]
```

**Connection dot:**

- Green when `ws.readyState === OPEN`.
- Orange while reconnecting (within the existing 2-second reconnect backoff loop).
- Red after three consecutive failed reconnect attempts.

**"Updated" label:** Set from a `lastListUpdate` timestamp written whenever a `session_list` event lands.

**Refresh button:** Sends `list_sessions`.

**Mobile:** The footer rides with the slide-out `.session-list` panel — same layout, no extra work needed.

### Toast Suppression

Remove the `showToast('Connection error', 'error')` call in `ws.onerror` (`index.html:733`). Track a `wsDownSince` timestamp; if the WebSocket stays closed for more than 5 seconds, then show a toast. The sidebar footer dot is the always-on indicator, so most short reconnects produce no UI noise at all.

### Disable Enter-to-Send

In the input `keydown` handler (`index.html:1195`), remove the `Enter && !shift → sendMessage()` branch entirely. The textarea handles Enter natively (inserts a newline). The send button click remains the only sender.

---

## Architecture & Data Flow

```
JSONL (on disk)
       │  (connect_session)
       ▼
connectSession ──► replay_start
                   for each entry:
                     normalizeMessage → message event (structured parts)
                                       │
                                       └─ or tool event (for tool results)
                   replay_end
       │  (live)
       ▼
handleAgentEvent ──► message / streaming / tool / session_update / queue_update
                                       │
                                       ▼
                              WebSocket broadcast
                                       │
                                       ▼
Client handleServerEvent ─► renderEntry  ─► DOM
                              (single path,
                               replay or live)
```

---

## Error Handling

- **Malformed JSONL lines during replay:** Skipped silently (same as today's `parseJsonlChunk`).
- **A `tool` replay event whose `toolCallId` has no companion `tool_use` part:** Render the tool card on its own (with `toolName` and result). Already consistent with how live tool events work.
- **`replay_end` arrives but no `replay_start` was seen:** Ignore the flag flip (defensive against re-connect races).
- **WS reconnect:** Replay re-runs from scratch on each reconnect (same as today). Client clears the message list before replaying so we don't double-render.

---

## Testing (Manual)

No automated test suite exists in this repo. Verification is manual:

1. Open a session that previously ran with tool calls — confirm tool cards and thinking blocks appear in chronological order, no empty bubbles, timestamps present.
2. With server running, run pi-CLI against the same session file from another terminal — confirm the indicator flips to "working" while pi-CLI writes and back to "idle" within ~15s of quiet.
3. Kill and restart the server while the page is open — confirm the sidebar footer dot turns orange then green; confirm no toast appears unless the outage exceeds 5s.
4. In the input box, press Enter — confirm a newline is inserted and nothing is sent. Click the send button — confirm send works.
5. Click the ↻ button in the sidebar footer — confirm "Updated" timestamp refreshes.

---

## Resolved Decisions & Trade-offs

| Decision | Choice | Rationale |
|---|---|---|
| Replay fidelity level | Full-fidelity (structured parts) | Rejected text+tool-summary because losing tool args/results removes the main reason to look at a historical session. Rejected text-only because it does not solve missing tool calls or thinking. |
| Activity-indicator visual | No visual change | The user feedback was that the indicator looks fine but lies about state — the fix is in the data, not the chrome. |
| Indicator placement | Sidebar footer only | One always-visible location is enough; keeping it in the sidebar groups it with session-list metadata it relates to. |
| Timestamp style | Below each bubble (muted), always visible | Date separators alone hide per-message granularity; always-visible works on mobile too. |
| `replay_start`/`replay_end` events | Explicit wire events | Cheaper than heuristics; lets the client safely switch off the streaming-append path during replay. |
| Idle-timer for external activity (15s) | Reuse existing timer | Trade-off: brief gaps between external writes (>15s) momentarily report idle. Acceptable: the current value already governs the driver-pill behavior. |
| Toast threshold (5s) | 5 seconds | Covers normal reconnect blips (2s backoff + handshake) without surfacing them as errors. |

---

## Open Questions for Claude

None identified. All design questions in the approved specification are resolved.
