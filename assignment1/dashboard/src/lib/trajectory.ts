import type {
  AgentEvent,
  AgentItem,
  DiagnosticItem,
  SessionMetadata,
} from "@/types";
import { calculateRunCost, DEFAULT_MODEL } from "./pricing.ts";

export type TimelineItem = {
  turn: number;
  item: AgentItem;
  eventType: string;
  timestamp?: string | number;
};

export type NormalizeOptions = {
  includeSystemEvents?: boolean;
};

// Item IDs are scoped to a turn; subsequent updates replace earlier snapshots.
// Also supports important turn/system events without items when includeSystemEvents is true.
export function normalizeTrajectory(
  events: AgentEvent[],
  options?: NormalizeOptions
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const positions = new Map<string, number>();
  let turn = 0;
  let eventSeq = 0;

  for (const event of events) {
    eventSeq++;
    if (event.type === "turn.started") turn++;

    if (!event.item) {
      if (options?.includeSystemEvents) {
        // Important turn-level or thread-level events that lack an item
        if (
          event.type === "turn.failed" ||
          event.type === "turn.completed" ||
          event.type === "thread.started" ||
          event.type === "warning" ||
          event.type === "error"
        ) {
          const sysId = `sys_${turn}_${eventSeq}_${event.type}`;
          const text =
            typeof event.message === "string"
              ? event.message
              : typeof event.error === "string"
              ? event.error
              : typeof event.error === "object" && event.error && "message" in event.error
              ? String(event.error.message)
              : event.type;

          items.push({
            turn,
            eventType: event.type,
            timestamp: event.timestamp,
            item: {
              id: sysId,
              type: "system_event",
              status: event.type === "turn.failed" || event.type === "error" ? "failed" : "completed",
              text,
            },
          });
        }
      }
      continue;
    }

    const key = event.item.id ? `${turn}:${event.item.id}` : undefined;
    const position = key === undefined ? undefined : positions.get(key);

    if (position !== undefined) {
      items[position] = {
        turn,
        item: { ...items[position].item, ...event.item },
        eventType: event.type,
        timestamp: event.timestamp ?? items[position].timestamp,
      };
    } else {
      if (key !== undefined) positions.set(key, items.length);
      items.push({
        turn,
        item: { ...event.item },
        eventType: event.type,
        timestamp: event.timestamp,
      });
    }
  }

  return items;
}

/**
 * Subagent / Task tree representation.
 * Represents a hierarchical task branch spawned by an agent.
 */
export type SubagentTaskGroup = {
  id: string;
  turn: number;
  title: string;
  status: string;
  items: TimelineItem[];
};

export type StructuredTurn = {
  turn: number;
  rootItems: TimelineItem[];
  tasks: SubagentTaskGroup[];
};

/**
 * Parses a flat timeline into a structured tree of subagents and tasks.
 * Gracefully identifies tasks if:
 * 1. item.type === "task" or "subagent"
 * 2. item.parentId is present pointing to a task id
 * 3. item.task or item.subagentId is defined
 */
export function buildSubagentTree(timeline: TimelineItem[]): StructuredTurn[] {
  const turnsMap = new Map<number, StructuredTurn>();

  for (const entry of timeline) {
    const turn = entry.turn || 1;
    if (!turnsMap.has(turn)) {
      turnsMap.set(turn, { turn, rootItems: [], tasks: [] });
    }
    const currentTurn = turnsMap.get(turn)!;
    const item = entry.item;

    const isTaskItem =
      item.type === "task" ||
      item.type === "subagent" ||
      (typeof item.id === "string" && item.id.startsWith("task_"));

    if (isTaskItem) {
      const taskId = item.id || `task_${currentTurn.tasks.length + 1}`;
      let existingTask = currentTurn.tasks.find((t) => t.id === taskId);
      if (!existingTask) {
        existingTask = {
          id: taskId,
          turn,
          title: item.title || item.task || item.text || "Subagent task",
          status: item.status || "completed",
          items: [],
        };
        currentTurn.tasks.push(existingTask);
      } else {
        existingTask.status = item.status || existingTask.status;
        if (item.title || item.task) existingTask.title = item.title || item.task || existingTask.title;
      }
      continue;
    }

    // Check if this item belongs to a parent task
    if (item.parentId) {
      const parentTask = currentTurn.tasks.find((t) => t.id === item.parentId);
      if (parentTask) {
        parentTask.items.push(entry);
        continue;
      }
    }

    // Check if item has subagentId or belongs to the most recent active task
    if (item.subagentId) {
      let subTask = currentTurn.tasks.find((t) => t.id === item.subagentId);
      if (!subTask) {
        subTask = {
          id: item.subagentId,
          turn,
          title: `Subagent ${item.subagentId.slice(0, 8)}`,
          status: "in_progress",
          items: [],
        };
        currentTurn.tasks.push(subTask);
      }
      subTask.items.push(entry);
      continue;
    }

    // Standard root-level item
    currentTurn.rootItems.push(entry);
  }

  return Array.from(turnsMap.values());
}

export type UsageResult = {
  input: number;
  cached: number;
  output: number;
  nonCached: number;
  turns: number;
  reasoning?: number;
};

// Cached input is already included in input tokens.
// Deduplicates turn.completed within the same turn boundary.
export function aggregateUsage(events: AgentEvent[]): UsageResult {
  let input = 0,
    cached = 0,
    output = 0,
    turns = 0,
    reasoning = 0;
  let counted = false;
  let hasReasoning = false;

  for (const event of events) {
    if (event.type === "turn.started") {
      counted = false;
    }
    if (event.type === "turn.completed" && event.usage && !counted) {
      input += event.usage.input_tokens ?? 0;
      cached += event.usage.cached_input_tokens ?? 0;
      output += event.usage.output_tokens ?? 0;
      if (typeof event.usage.reasoning_output_tokens === "number") {
        reasoning += event.usage.reasoning_output_tokens;
        hasReasoning = true;
      }
      turns++;
      counted = true;
    }
  }

  const result: UsageResult = {
    input,
    cached,
    output,
    nonCached: Math.max(0, input - cached),
    turns,
  };

  if (hasReasoning) {
    result.reasoning = reasoning;
  }

  return result;
}

export type TurnUsageDetail = {
  turn: number;
  input: number;
  cached: number;
  nonCached: number;
  output: number;
  reasoning?: number;
  costUSD?: number;
  costFormatted?: string;
};

// Detailed breakdown of usage per turn
export function getTurnUsageBreakdown(
  events: AgentEvent[],
  modelName: string = DEFAULT_MODEL
): TurnUsageDetail[] {
  const breakdown: TurnUsageDetail[] = [];
  let currentTurn = 0;
  let turnCounted = false;

  for (const event of events) {
    if (event.type === "turn.started") {
      currentTurn++;
      turnCounted = false;
    }
    if (event.type === "turn.completed" && event.usage && !turnCounted) {
      const input = event.usage.input_tokens ?? 0;
      const cached = event.usage.cached_input_tokens ?? 0;
      const output = event.usage.output_tokens ?? 0;
      const nonCached = Math.max(0, input - cached);

      const cost = calculateRunCost(
        { input, cached, nonCached, output },
        modelName
      );

      const detail: TurnUsageDetail = {
        turn: currentTurn,
        input,
        cached,
        nonCached,
        output,
        costUSD: cost.costUSD,
        costFormatted: cost.formattedCost,
      };
      if (typeof event.usage.reasoning_output_tokens === "number") {
        detail.reasoning = event.usage.reasoning_output_tokens;
      }
      breakdown.push(detail);
      turnCounted = true;
    }
  }

  return breakdown;
}

// Compute tool execution and token statistics for a session
export function calculateSessionStats(
  events: AgentEvent[],
  modelName: string = DEFAULT_MODEL
) {
  const normalized = normalizeTrajectory(events);
  let toolCallsCount = 0;
  let toolErrorsCount = 0;

  for (const item of normalized) {
    if (item.item.type === "command_execution" || item.item.command !== undefined) {
      toolCallsCount++;
      if (item.item.exit_code != null && item.item.exit_code !== 0) {
        toolErrorsCount++;
      } else if (item.item.status === "failed") {
        toolErrorsCount++;
      }
    }
  }

  const usage = aggregateUsage(events);
  const cost = calculateRunCost(usage, modelName);

  return {
    toolCallsCount,
    toolErrorsCount,
    usage,
    turns: usage.turns,
    costUSD: cost.costUSD,
    costFormatted: cost.formattedCost,
    model: cost.model,
  };
}

// Aggregation across multiple saved sessions
export function aggregateSessions(sessions: SessionMetadata[]) {
  const totalSessions = sessions.length;
  let totalInput = 0;
  let totalCached = 0;
  let totalNonCached = 0;
  let totalOutput = 0;
  let totalTurns = 0;
  let totalToolCalls = 0;
  let totalToolErrors = 0;
  let totalCostUSD = 0;

  for (const s of sessions) {
    const input = s.inputTokens ?? 0;
    const cached = s.cachedInputTokens ?? 0;
    const nonCached = s.nonCachedInputTokens ?? Math.max(0, input - cached);
    const output = s.outputTokens ?? 0;

    totalInput += input;
    totalCached += cached;
    totalNonCached += nonCached;
    totalOutput += output;
    totalTurns += s.turns ?? 0;
    totalToolCalls += s.toolCallsCount ?? 0;
    totalToolErrors += s.toolErrorsCount ?? 0;
    totalCostUSD += s.costUSD ?? 0;
  }

  let formattedTotalCost = "$0.00";
  if (totalCostUSD >= 0.01) {
    formattedTotalCost = `$${totalCostUSD.toFixed(2)}`;
  } else if (totalCostUSD > 0) {
    formattedTotalCost = `$${totalCostUSD.toFixed(4)}`;
  }

  return {
    totalSessions,
    totalInput,
    totalCached,
    totalNonCached,
    totalOutput,
    totalTurns,
    totalToolCalls,
    totalToolErrors,
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    formattedTotalCost,
  };
}

// Classify and extract actionable diagnostics from events and run status
export function extractDiagnostics(
  events: AgentEvent[],
  options?: {
    exitCode?: number | null;
    error?: string;
    cancelled?: boolean;
    timedOut?: boolean;
    storageFailed?: boolean;
  }
): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const normalized = normalizeTrajectory(events);

  // 1. Tool-level command failures (distinguished from agent-level failures)
  for (const entry of normalized) {
    const { item, turn } = entry;
    if (item.type === "command_execution" || item.command) {
      if (item.exit_code != null && item.exit_code !== 0) {
        diagnostics.push({
          category: "command_failure",
          severity: "warning",
          turn,
          itemId: item.id,
          message: `Tool command exited with non-zero code ${item.exit_code}`,
          details: item.command,
        });
      }
    }
  }

  // 2. Turn-level failures
  let turnIdx = 0;
  for (const event of events) {
    if (event.type === "turn.started") turnIdx++;
    if (event.type === "turn.failed") {
      const msg =
        typeof event.message === "string"
          ? event.message
          : typeof event.error === "string"
          ? event.error
          : "Turn execution failed";

      diagnostics.push({
        category: "turn_failure",
        severity: "error",
        turn: turnIdx,
        message: msg,
      });
    }
  }

  // 3. Process / run-level diagnostics
  if (options?.timedOut) {
    diagnostics.push({
      category: "timeout",
      severity: "error",
      message: "Agent execution reached the timeout limit (120s)",
    });
  }

  if (options?.cancelled) {
    diagnostics.push({
      category: "cancellation",
      severity: "info",
      message: "Agent run was cancelled by the user",
    });
  }

  if (options?.storageFailed) {
    diagnostics.push({
      category: "persistence_failure",
      severity: "error",
      message: "Session metadata or event persistence failed to save to disk",
    });
  }

  if (options?.exitCode != null && options.exitCode !== 0 && !options?.cancelled && !options?.timedOut) {
    diagnostics.push({
      category: "non_zero_exit",
      severity: "error",
      message: `Process exited unexpectedly with code ${options.exitCode}`,
    });
  }

  if (options?.error) {
    const isSpawn = options.error.toLowerCase().includes("spawn") || options.error.toLowerCase().includes("enoent");
    diagnostics.push({
      category: isSpawn ? "spawn_error" : "turn_failure",
      severity: "error",
      message: options.error,
    });
  }

  return diagnostics;
}
