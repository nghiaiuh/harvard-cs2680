import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, normalizeTrajectory } from "../src/lib/trajectory.ts";

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
