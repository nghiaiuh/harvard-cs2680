import { test } from "node:test";
import assert from "node:assert/strict";

function parseSSEFrames(chunks) {
  let buffer = "";
  const received = [];

  function handleFrame(frame) {
    const lines = frame.split("\n");
    let eventName = "message";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join("\n"));
    received.push({ event: eventName, data });
  }

  for (const chunk of chunks) {
    buffer += chunk;
    buffer = buffer.replace(/\r\n/g, "\n");
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      handleFrame(frame);
    }
  }

  if (buffer.trim()) {
    handleFrame(buffer);
  }

  return received;
}

test("parses multi-frame and fragmented SSE chunks cleanly", () => {
  const chunks = [
    "event: status\r\ndata: {\"message\":\"Starting\"}\r\n\r\n",
    "event: agent\r\ndata: {\"type\":\"turn.started\"}\r\n\r\nevent: agent\r\n",
    "data: {\"type\":\"item.started\",\"item\":{\"id\":\"1\"}}\r\n\r\n",
    "event: done\r\ndata: {\"status\":\"completed\",\"exitCode\":0}\r\n\r\n",
  ];

  const parsed = parseSSEFrames(chunks);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].event, "status");
  assert.equal(parsed[0].data.message, "Starting");
  assert.equal(parsed[1].data.type, "turn.started");
  assert.equal(parsed[2].data.item.id, "1");
  assert.equal(parsed[3].event, "done");
  assert.equal(parsed[3].data.status, "completed");
});

test("detects prematurely interrupted stream missing done frame", () => {
  const chunks = [
    "event: status\ndata: {\"message\":\"Starting\"}\n\n",
    "event: agent\ndata: {\"type\":\"turn.started\"}\n\n",
    // Connection drops here without done event
  ];

  const parsed = parseSSEFrames(chunks);
  const hasDone = parsed.some((p) => p.event === "done");
  assert.equal(hasDone, false);
});

