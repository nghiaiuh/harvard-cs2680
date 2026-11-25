import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  startSession,
  saveEvent,
  finishSession,
  getSession,
  listSessions,
  acquireSessionLock,
  validateThreadId,
} from "../src/lib/session-store.ts";

const TEST_THREAD_ID = "99999999-aaaa-bbbb-cccc-000000000001";
const SESSIONS_DIR = path.resolve(process.cwd(), "../sessions");
const TEST_DIR = path.join(SESSIONS_DIR, TEST_THREAD_ID);

test("validates thread ID and rejects path traversal or invalid format", () => {
  assert.throws(() => validateThreadId("../../../etc/passwd"), /Invalid thread ID/);
  assert.throws(() => validateThreadId("invalid-uuid"), /Invalid thread ID/);
  assert.doesNotThrow(() => validateThreadId("01a1ed4a-8466-7410-9aa9-3807b0d68b01"));
});

test("creates and finishes session with atomic metadata writes", async (t) => {
  // Cleanup beforehand
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  t.after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  const metadata = await startSession(TEST_THREAD_ID, "Test initial prompt for unit testing");
  assert.equal(metadata.threadId, TEST_THREAD_ID);
  assert.equal(metadata.status, "running");
  assert.equal(metadata.turns, 1);

  // Append events without overwriting
  await saveEvent(TEST_THREAD_ID, { type: "turn.started" });
  await saveEvent(TEST_THREAD_ID, {
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command: "echo hello", exit_code: 0 },
  });
  await saveEvent(TEST_THREAD_ID, {
    type: "turn.completed",
    usage: { input_tokens: 150, cached_input_tokens: 50, output_tokens: 30 },
  });

  const finished = await finishSession(TEST_THREAD_ID, true, undefined, {
    startedAt: Date.now() - 5000,
    endedAt: Date.now(),
  });

  assert.equal(finished.status, "completed");
  assert.equal(finished.turns, 1);
  assert.equal(finished.toolCallsCount, 1);
  assert.equal(finished.toolErrorsCount, 0);
  assert.equal(finished.inputTokens, 150);
  assert.equal(finished.cachedInputTokens, 50);
  assert.equal(finished.nonCachedInputTokens, 100);
  assert.equal(finished.outputTokens, 30);
  assert.equal(finished.totalTokens, 180);
  assert.ok(finished.durationMs >= 4500);

  // Verify retrieval
  const sessionData = await getSession(TEST_THREAD_ID);
  assert.equal(sessionData.events.length, 3);
  assert.equal(sessionData.metadata.status, "completed");

  const all = await listSessions();
  assert.ok(all.some((s) => s.threadId === TEST_THREAD_ID));
});

test("handles partial/corrupted trailing JSONL lines gracefully without throwing", async (t) => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  t.after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  await startSession(TEST_THREAD_ID, "Partial JSONL test");
  await saveEvent(TEST_THREAD_ID, { type: "turn.started" });

  // Simulate abrupt power cut / crash writing a partial truncated JSON line
  const eventsFile = path.join(TEST_DIR, "events.jsonl");
  const corruptedContent = '{"type":"item.started","item":{"id":"corrupt';
  await writeFile(eventsFile, corruptedContent, { flag: "a", encoding: "utf8" });

  const retrieved = await getSession(TEST_THREAD_ID);
  // Valid line should be parsed, corrupt line should be ignored safely
  assert.equal(retrieved.events.length, 1);
  assert.equal(retrieved.events[0].type, "turn.started");
});

test("session lock prevents concurrent runs and handles stale locks", async (t) => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  t.after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  // First acquisition succeeds
  const release = await acquireSessionLock(TEST_THREAD_ID);

  // Second acquisition fails immediately with 409 error
  await assert.rejects(
    async () => {
      await acquireSessionLock(TEST_THREAD_ID);
    },
    /Session is currently locked/
  );

  // Release lock
  await release();

  // Can acquire again after release
  const release2 = await acquireSessionLock(TEST_THREAD_ID);
  await release2();
});

test("stale lock with dead PID is automatically recovered", async (t) => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  t.after(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  // Create artificial lock file with a dead PID (e.g. 99999999)
  const lockFile = path.join(TEST_DIR, "session.lock");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(lockFile, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 500000 }));

  // Should identify as stale and acquire successfully
  const release = await acquireSessionLock(TEST_THREAD_ID);
  assert.ok(release);
  await release();
});
