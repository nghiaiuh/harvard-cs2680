
"use client";

import { useState } from "react";
import type { RunResult } from "@/types";

export function AgentRunner() {
  const [prompt, setPrompt] = useState(
    "Inspect calculator.js and calculator.test.js. " +
    "Run npm test and report whether all tests pass. " +
    "Do not modify any files."
  );

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState("");

  // Sends the prompt to the local Codex API and stores its result.
  async function runAgent() {
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Request failed");
      }

      setResult(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setLoading(false);
    }
  }

  const finalMessage = result?.events
    .filter(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
    )
    .at(-1)?.item?.text;

  const usage = result?.events
    .filter((event) => event.type === "turn.completed")
    .at(-1)?.usage;

  const threadId = result?.events.find(
    (event) => event.type === "thread.started"
  )?.thread_id;

  return (
    <section className="space-y-4 rounded-xl border p-5">
      <h2 className="text-xl font-semibold">
        Run Codex Agent
      </h2>

      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={5}
        maxLength={4000}
        disabled={loading}
        className="w-full rounded-lg border border-white/15 bg-slate-950/60 p-3 text-white caret-cyan-300 placeholder:text-slate-500 focus:border-cyan-300/60 focus:outline-none focus:ring-2 focus:ring-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-60"
      />

      <button
        onClick={runAgent}
        disabled={loading || !prompt.trim()}
        className="rounded-lg bg-blue-600 px-5 py-2 font-medium text-white disabled:opacity-50"
      >
        {loading ? "Agent running..." : "Run Agent"}
      </button>

      {loading && (
        <p className="text-sm text-gray-500">
          Waiting for Codex to finish...
        </p>
      )}

      {error && (
        <p className="text-red-500">{error}</p>
      )}

      {result && (
        <div className="space-y-3">
          <p className="font-semibold">
            Status: {result.success ? "Completed" : "Failed"}
          </p>

          <p className="break-all text-sm">
            Thread ID: {threadId ?? "Unavailable"}
          </p>

          <p className="text-sm">
            Events: {result.events.length}
          </p>

          {usage && (
            <p className="text-sm">
              Input: {usage.input_tokens ?? 0} |
              Cached: {usage.cached_input_tokens ?? 0} |
              Output: {usage.output_tokens ?? 0}
            </p>
          )}

          {finalMessage && (
            <div className="rounded-lg bg-gray-100 p-4 text-gray-900">
              <h3 className="mb-2 font-semibold">
                Agent Response
              </h3>
              <p className="whitespace-pre-wrap">
                {finalMessage}
              </p>
            </div>
          )}

          {result.stderr && !result.success && (
            <details>
              <summary>View stderr</summary>
              <pre className="overflow-auto whitespace-pre-wrap text-xs">
                {result.stderr}
              </pre>
            </details>
          )}

          <details>
            <summary className="cursor-pointer">
              View raw events
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-gray-100 p-3 text-xs text-gray-900">
              {JSON.stringify(result.events, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}
