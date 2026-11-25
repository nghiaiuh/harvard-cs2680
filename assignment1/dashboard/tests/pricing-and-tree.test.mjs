import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRunCost } from "../src/lib/pricing.ts";
import { buildSubagentTree } from "../src/lib/trajectory.ts";

test("calculates USD run cost accurately with caching discount", () => {
  // 1M non-cached input ($2.50) + 1M cached input ($1.25) + 100k output ($1.00) = $4.75
  const result = calculateRunCost({
    input: 2_000_000,
    cached: 1_000_000,
    nonCached: 1_000_000,
    output: 100_000,
  }, "gpt-5.6-luna");

  assert.equal(result.costUSD, 4.75);
  assert.equal(result.formattedCost, "$4.75");
  assert.equal(result.isEstimated, true);
  assert.equal(result.breakdown.inputCost, 2.5);
  assert.equal(result.breakdown.cachedCost, 1.25);
  assert.equal(result.breakdown.outputCost, 1.0);
});

test("formats sub-cent and zero costs properly", () => {
  const zero = calculateRunCost({ input: 0, output: 0 });
  assert.equal(zero.formattedCost, "$0.00");

  const tiny = calculateRunCost({ input: 500, cached: 200, output: 100 });
  assert.ok(tiny.formattedCost.startsWith("$0.00"));
  assert.ok(tiny.costUSD > 0);
});

test("builds hierarchical subagent task tree", () => {
  const timeline = [
    { turn: 1, eventType: "item.completed", item: { id: "1", type: "command_execution", command: "cat README.md" } },
    // Subagent Task 1
    { turn: 1, eventType: "item.started", item: { id: "task_1", type: "task", title: "survey the code", status: "completed" } },
    { turn: 1, eventType: "item.completed", item: { id: "sub_1", parentId: "task_1", command: "grep json", type: "command_execution" } },
    // Subagent Task 2
    { turn: 1, eventType: "item.started", item: { id: "task_2", type: "task", title: "survey the docs", status: "in_progress" } },
    { turn: 1, eventType: "item.completed", item: { id: "sub_2", parentId: "task_2", command: "cat docs.md", type: "command_execution" } },
    // Root action after tasks
    { turn: 1, eventType: "item.completed", item: { id: "root_2", type: "file_change", changes: [{ path: "README.md", kind: "update" }] } },
  ];

  const tree = buildSubagentTree(timeline);
  assert.equal(tree.length, 1);
  const turn1 = tree[0];
  assert.equal(turn1.turn, 1);
  assert.equal(turn1.rootItems.length, 2); // cat README and file change
  assert.equal(turn1.tasks.length, 2);
  assert.equal(turn1.tasks[0].title, "survey the code");
  assert.equal(turn1.tasks[0].items.length, 1);
  assert.equal(turn1.tasks[0].items[0].item.command, "grep json");
  assert.equal(turn1.tasks[1].title, "survey the docs");
  assert.equal(turn1.tasks[1].items.length, 1);
});

