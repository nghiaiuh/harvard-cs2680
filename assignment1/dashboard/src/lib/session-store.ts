import "server-only";

import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  appendFile,
  unlink,
  rename,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AgentStatus, SessionMetadata } from "@/types";
import { calculateSessionStats } from "./trajectory.ts";

const ROOT = path.resolve(process.cwd(), "../sessions");
const LOCK_TIMEOUT_MS = 120_000; // 2 minutes matching agent timeout

export type { SessionMetadata };

export function validateThreadId(threadId: string): void {
  if (!/^[a-f0-9-]{36}$/.test(threadId)) {
    throw new Error("Invalid thread ID");
  }
}

function sessionDir(threadId: string) {
  validateThreadId(threadId);
  return path.join(ROOT, threadId);
}

function lockFilePath(threadId: string) {
  return path.join(sessionDir(threadId), "session.lock");
}

function isProcessAlive(pid: number): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // Exists but not permitted to signal
  }
}

/**
 * Acquire file-based exclusive lock for a session to prevent concurrent executions
 * across multiple server instances or threads.
 */
export async function acquireSessionLock(threadId: string): Promise<() => Promise<void>> {
  const dir = sessionDir(threadId);
  await mkdir(dir, { recursive: true });
  const lockFile = lockFilePath(threadId);

  const lockPayload = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
  });

  try {
    // Flag 'wx' fails if the file already exists (atomic create)
    await writeFile(lockFile, lockPayload, { flag: "wx", encoding: "utf8" });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EEXIST") {
      // Check if stale lock
      let stale = false;
      try {
        const existingData = await readFile(lockFile, "utf8");
        const parsed = JSON.parse(existingData);
        const age = Date.now() - (parsed.createdAt ?? 0);
        const processDead = parsed.pid && !isProcessAlive(parsed.pid);

        if (age > LOCK_TIMEOUT_MS || processDead) {
          stale = true;
        }
      } catch {
        // Unparseable or corrupt lock file is considered stale
        stale = true;
      }

      if (stale) {
        try {
          await unlink(lockFile);
          // Try acquiring one more time
          await writeFile(lockFile, lockPayload, { flag: "wx", encoding: "utf8" });
        } catch {
          throw new Error("Session is currently locked by another active process");
        }
      } else {
        throw new Error("Session is currently locked by another active process");
      }
    } else {
      throw err;
    }
  }

  // Return release function
  return async () => {
    try {
      await unlink(lockFile);
    } catch {
      // Ignore if already deleted
    }
  };
}

async function writeAtomicJson(filePath: string, data: unknown) {
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const content = JSON.stringify(data, null, 2);
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch {
    await copyFile(tempPath, filePath);
    await unlink(tempPath).catch(() => {});
  }
}

export async function readMetadata(threadId: string): Promise<SessionMetadata> {
  const content = await readFile(
    path.join(sessionDir(threadId), "metadata.json"),
    "utf8"
  );
  return JSON.parse(content) as SessionMetadata;
}

export async function startSession(
  threadId: string,
  prompt: string
): Promise<SessionMetadata> {
  const dir = sessionDir(threadId);
  await mkdir(dir, { recursive: true });

  let existing: SessionMetadata | null = null;
  try {
    existing = await readMetadata(threadId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const now = new Date().toISOString();

  const metadata: SessionMetadata = {
    threadId,
    title: existing?.title ?? prompt.slice(0, 80),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    status: "running",
    turns: (existing?.turns ?? 0) + 1,
    startedAt: now,
    // Preserve existing statistics if any
    endedAt: undefined,
    durationMs: existing?.durationMs,
    totalTokens: existing?.totalTokens,
    inputTokens: existing?.inputTokens,
    cachedInputTokens: existing?.cachedInputTokens,
    nonCachedInputTokens: existing?.nonCachedInputTokens,
    outputTokens: existing?.outputTokens,
    reasoningOutputTokens: existing?.reasoningOutputTokens,
    toolCallsCount: existing?.toolCallsCount,
    toolErrorsCount: existing?.toolErrorsCount,
  };

  await writeAtomicJson(path.join(dir, "metadata.json"), metadata);
  return metadata;
}

export async function saveEvent(threadId: string, event: unknown) {
  await appendFile(
    path.join(sessionDir(threadId), "events.jsonl"),
    JSON.stringify(event) + "\n",
    "utf8"
  );
}

export async function finishSession(
  threadId: string,
  success: boolean,
  outcome?: "cancelled" | "timed_out",
  executionTimes?: { startedAt?: number; endedAt?: number }
): Promise<SessionMetadata> {
  let metadata: SessionMetadata;
  try {
    metadata = await readMetadata(threadId);
  } catch {
    const now = new Date().toISOString();
    metadata = {
      threadId,
      title: "Agent session",
      createdAt: now,
      updatedAt: now,
      status: "running",
      turns: 1,
    };
  }

  const finishedAtDate = new Date();
  const finishedAtStr = finishedAtDate.toISOString();

  let finalStatus: AgentStatus;
  if (outcome === "cancelled") {
    finalStatus = "cancelled";
  } else if (outcome === "timed_out") {
    finalStatus = "timed_out";
  } else {
    finalStatus = success ? "completed" : "failed";
  }

  metadata.status = finalStatus;
  metadata.updatedAt = finishedAtStr;
  metadata.endedAt = finishedAtStr;

  if (executionTimes?.startedAt) {
    metadata.startedAt = new Date(executionTimes.startedAt).toISOString();
    const end = executionTimes.endedAt ?? finishedAtDate.getTime();
    metadata.durationMs = Math.max(0, end - executionTimes.startedAt);
  } else if (metadata.startedAt) {
    const startMs = new Date(metadata.startedAt).getTime();
    if (!isNaN(startMs)) {
      metadata.durationMs = Math.max(0, finishedAtDate.getTime() - startMs);
    }
  }

  // Calculate and persist updated token and tool statistics from events.jsonl
  try {
    const { events } = await getSession(threadId);
    const stats = calculateSessionStats(events);
    metadata.turns = Math.max(metadata.turns, stats.turns);
    metadata.toolCallsCount = stats.toolCallsCount;
    metadata.toolErrorsCount = stats.toolErrorsCount;
    metadata.inputTokens = stats.usage.input;
    metadata.cachedInputTokens = stats.usage.cached;
    metadata.nonCachedInputTokens = stats.usage.nonCached;
    metadata.outputTokens = stats.usage.output;
    metadata.totalTokens = stats.usage.input + stats.usage.output;
    if (stats.usage.reasoning !== undefined) {
      metadata.reasoningOutputTokens = stats.usage.reasoning;
    }
    metadata.costUSD = stats.costUSD;
    metadata.costFormatted = stats.costFormatted;
    metadata.model = stats.model;
  } catch {
    // If events cannot be read, keep existing stats
  }

  await writeAtomicJson(path.join(sessionDir(threadId), "metadata.json"), metadata);
  return metadata;
}

export async function listSessions(): Promise<SessionMetadata[]> {
  await mkdir(ROOT, { recursive: true });

  const entries = await readdir(ROOT, {
    withFileTypes: true,
  });

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))
      .map(async (entry) => {
        try {
          return await readMetadata(entry.name);
        } catch {
          return null;
        }
      })
  );

  return sessions
    .filter((s): s is SessionMetadata => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getSession(threadId: string): Promise<{
  metadata: SessionMetadata;
  events: AgentEvent[];
}> {
  validateThreadId(threadId);
  const metadata = await readMetadata(threadId);

  let content = "";
  try {
    content = await readFile(
      path.join(sessionDir(threadId), "events.jsonl"),
      "utf8"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // Fault-tolerant parsing: skip partial/corrupt trailing lines without throwing
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const events: AgentEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore partial/malformed JSONL line safely
    }
  }

  return { metadata, events };
}
