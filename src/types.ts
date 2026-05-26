// WebSocket protocol types for web-pi

// ─── Server → Client events ───────────────────────────────────────────────────

export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export interface SessionListEvent extends ServerEvent {
  type: "session_list";
  sessions: SessionInfo[];
}

export interface SessionUpdateEvent extends ServerEvent {
  type: "session_update";
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  model?: string;
  thinkingLevel?: string;
  messageCount?: number;
  /** Who currently owns writes to this session. */
  driver?: "none" | "external" | "self";
  /** Echoed back on connect to confirm which session this client is bound to. */
  clientSessionId?: string;
}

export interface MessageEvent extends ServerEvent {
  type: "message";
  sessionId: string;
  message: PiMessage;
}

export interface StreamingEvent extends ServerEvent {
  type: "streaming";
  sessionId: string;
  delta: string;
  isThinking?: boolean;
}

export interface ToolEvent extends ServerEvent {
  type: "tool";
  sessionId: string;
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  status: "start" | "update" | "end";
  result?: string;
  isError?: boolean;
}

export interface QueueUpdateEvent extends ServerEvent {
  type: "queue_update";
  sessionId: string;
  steering: string[];
  followUp: string[];
}

export interface CompactionEvent extends ServerEvent {
  type: "compaction";
  sessionId: string;
  phase: "start" | "end";
  summary?: string;
}

export interface EventError extends ServerEvent {
  type: "error";
  message: string;
}

export interface StateEvent extends ServerEvent {
  type: "state";
  data: PiState | null;
}

export interface MessagesEvent extends ServerEvent {
  type: "messages";
  data: PiMessage[];
}

// ─── Client → Server commands ─────────────────────────────────────────────────

export interface ClientCommand {
  type: string;
  [key: string]: unknown;
}

export interface ListSessionsCommand extends ClientCommand {
  type: "list_sessions";
}

export interface ConnectSessionCommand extends ClientCommand {
  type: "connect_session";
  sessionFile: string;
}

export interface DisconnectSessionCommand extends ClientCommand {
  type: "disconnect_session";
}

export interface ReleaseSessionCommand extends ClientCommand {
  type: "release_session";
}

export interface PromptCommand extends ClientCommand {
  type: "prompt";
  message: string;
  streamingBehavior?: "steer" | "followUp";
}

export interface AbortCommand extends ClientCommand {
  type: "abort";
}

export interface NewSessionCommand extends ClientCommand {
  type: "new_session";
}

export interface SetModelCommand extends ClientCommand {
  type: "set_model";
  provider: string;
  modelId: string;
}

export interface SetThinkingLevelCommand extends ClientCommand {
  type: "set_thinking_level";
  level: string;
}

export interface CompactCommand extends ClientCommand {
  type: "compact";
  customInstructions?: string;
}

export interface SetSessionNameCommand extends ClientCommand {
  type: "set_session_name";
  name: string;
}

export interface GetStateCommand extends ClientCommand {
  type: "get_state";
}

export interface GetMessagesCommand extends ClientCommand {
  type: "get_messages";
}

export type AnyClientCommand =
  | ListSessionsCommand
  | ConnectSessionCommand
  | DisconnectSessionCommand
  | PromptCommand
  | AbortCommand
  | NewSessionCommand
  | SetModelCommand
  | SetThinkingLevelCommand
  | CompactCommand
  | SetSessionNameCommand
  | GetStateCommand
  | GetMessagesCommand;

// ─── Pi message types ─────────────────────────────────────────────────────────

export interface PiMessage {
  role: "user" | "assistant" | "toolResult" | "bashExecution";
  content: string | ContentBlock[];
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  usage?: MessageUsage;
}

export interface ContentBlock {
  type: "text" | "thinking" | "toolCall";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: CostInfo;
}

export interface CostInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// ─── Session info ─────────────────────────────────────────────────────────────

export interface SessionInfo {
  file: string;
  id: string;
  name?: string;
  entryCount: number;
  timestamp: number;
}

// ─── State response ───────────────────────────────────────────────────────────

export interface PiState {
  model: ModelInfo | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: string;
  followUpMode: string;
  sessionFile: string | null;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: CostInfo;
}
