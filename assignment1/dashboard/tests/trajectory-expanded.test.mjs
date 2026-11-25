import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateUsage,
  normalizeTrajectory,
  getTurnUsageBreakdown,
  calculateSessionStats,
  aggregateSessions,
  extractDiagnostics,
} from "../src/lib/trajectory.ts";

test("groups item updates within a turn and preserves order", () => {
  const items = normalizeTrajectory([
    { type: "turn.started" },
    { type: "item.started", item: { id: "a", command: "test", status: "in_progress" } },
    { type: "item.completed", item: { id: "a", exit_code: 0, status: "completed" } },
    { type: "turn.started" },
    { type: "item.started", item: { id: "a", command: "again" } },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].item.command, "test");
  assert.equal(items[0].item.exit_code, 0);
  assert.equal(items[1].turn, 2);
});

test("counts usage once per turn and excludes cached input", () => {
  const done = { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 10 } };
  assert.deepEqual(aggregateUsage([{ type: "turn.started" }, done, done, { type: "turn.started" }, done]),
    { input: 200, cached: 60, nonCached: 140, output: 20, turns: 2 });
});

test("includes system and turn events when includeSystemEvents is true", () => {
  const events = [
    { type: "thread.started", thread_id: "thread-123" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "cmd_1", command: "ls", status: "in_progress" } },
    { type: "turn.failed", message: "Turn execution timed out in agent" },
  ];

  const items = normalizeTrajectory(events, { includeSystemEvents: true });
  assert.equal(items.length, 3);
  assert.equal(items[0].eventType, "thread.started");
  assert.equal(items[1].item.command, "ls");
  assert.equal(items[2].eventType, "turn.failed");
  assert.equal(items[2].item.status, "failed");
  assert.equal(items[2].item.text, "Turn execution timed out in agent");
});

test("handles reasoning tokens accurately only when present", () => {
  const withReasoning = {
    type: "turn.completed",
    usage: {
      input_tokens: 1000,
      cached_input_tokens: 400,
      output_tokens: 200,
      reasoning_output_tokens: 50,
    },
  };

  const usage = aggregateUsage([{ type: "turn.started" }, withReasoning]);
  assert.equal(usage.input, 1000);
  assert.equal(usage.cached, 400);
  assert.equal(usage.nonCached, 600);
  assert.equal(usage.output, 200);
  assert.equal(usage.reasoning, 50);
});

test("computes per-turn breakdown accurately", () => {
  const events = [
    { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 100, reasoning_output_tokens: 25 } },
    { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 800, cached_input_tokens: 500, output_tokens: 150 } },
  ];

  const breakdown = getTurnUsageBreakdown(events);
  assert.equal(breakdown.length, 2);
  assert.equal(breakdown[0].turn, 1);
  assert.equal(breakdown[0].nonCached, 300);
  assert.equal(breakdown[0].reasoning, 25);
  assert.equal(breakdown[1].turn, 2);
  assert.equal(breakdown[1].nonCached, 300);
  assert.equal(breakdown[1].reasoning, undefined);
});

test("computes session stats differentiating tool errors from agent failure", () => {
  const events = [
    { type: "turn.started" },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test" } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", exit_code: 1, status: "completed" } },
    { type: "item.started", item: { id: "c2", type: "command_execution", command: "git status" } },
    { type: "item.completed", item: { id: "c2", type: "command_execution", command: "git status", exit_code: 0, status: "completed" } },
    { type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 50 } },
  ];

  const stats = calculateSessionStats(events);
  assert.equal(stats.toolCallsCount, 2);
  assert.equal(stats.toolErrorsCount, 1);
  assert.equal(stats.turns, 1);
});

test("extracts actionable diagnostics for non-zero exit, command failure, and timeout", () => {
  const events = [
    { type: "turn.started" },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "node broken.js", exit_code: 1 } },
  ];

  const diags = extractDiagnostics(events, { exitCode: 1, timedOut: true });
  assert.ok(diags.some((d) => d.category === "command_failure" && d.severity === "warning"));
  assert.ok(diags.some((d) => d.category === "timeout" && d.severity === "error"));
});

test("aggregates across multiple sessions", () => {
  const sessions = [
    {
      threadId: "00000000-0000-0000-0000-000000000001",
      title: "S1",
      createdAt: "",
      updatedAt: "",
      status: "completed",
      turns: 2,
      inputTokens: 1000,
      cachedInputTokens: 300,
      nonCachedInputTokens: 700,
      outputTokens: 200,
      toolCallsCount: 3,
      toolErrorsCount: 0,
    },
    {
      threadId: "00000000-0000-0000-0000-000000000002",
      title: "S2",
      createdAt: "",
      updatedAt: "",
      status: "failed",
      turns: 1,
      inputTokens: 500,
      cachedInputTokens: 100,
      nonCachedInputTokens: 400,
      outputTokens: 50,
      toolCallsCount: 2,
      toolErrorsCount: 1,
    },
  ];

  const agg = aggregateSessions(sessions);
  assert.equal(agg.totalSessions, 2);
  assert.equal(agg.totalInput, 1500);
  assert.equal(agg.totalCached, 400);
  assert.equal(agg.totalNonCached, 1100);
  assert.equal(agg.totalOutput, 250);
  assert.equal(agg.totalTurns, 3);
  assert.equal(agg.totalToolCalls, 5);
  assert.equal(agg.totalToolErrors, 1);
});

