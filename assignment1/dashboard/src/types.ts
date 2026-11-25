export type AgentUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
};

export type AgentItem = {
  id?: string;
  parentId?: string;
  subagentId?: string;
  type?: string;
  task?: string;
  title?: string;
  status?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  changes?: { path: string; kind?: string }[];
  children?: AgentItem[];
};

export type AgentEvent = {
  type: string;
  thread_id?: string;
  subagent_id?: string;
  parent_id?: string;
  model?: string;
  item?: AgentItem;
  usage?: AgentUsage;
  timestamp?: string | number;
  error?: string | { message?: string; code?: string };
  message?: string;
  [key: string]: unknown;
};

export type RunResult = {
  success: boolean;
  exitCode: number | null;
  stderr: string;
  events: AgentEvent[];
};

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCategory =
  | "spawn_error"
  | "non_zero_exit"
  | "turn_failure"
  | "command_failure"
  | "jsonl_parse_error"
  | "sse_interrupted"
  | "timeout"
  | "cancellation"
  | "persistence_failure";

export type DiagnosticItem = {
  category: DiagnosticCategory;
  message: string;
  severity: DiagnosticSeverity;
  details?: string;
  turn?: number;
  itemId?: string;
  timestamp?: string;
};

export type SessionMetadata = {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: AgentStatus;
  turns: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  nonCachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  toolCallsCount?: number;
  toolErrorsCount?: number;
  costUSD?: number;
  costFormatted?: string;
  model?: string;
};
