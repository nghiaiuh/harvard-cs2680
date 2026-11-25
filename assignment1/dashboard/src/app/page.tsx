"use client";

import { LiveAgentRunner } from "@/components/live-agent-runner";
import type { AgentEvent } from "@/types";
import { useEffect, useState } from "react";

// Displays the dashboard and loads the saved agent trajectory.
export default function Home() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Fetch the latest recorded events when the page opens.
  useEffect(() => {
    fetch("/api/trajectory")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load trajectory");
        }

        return response.json();
      })
      .then((data) => setEvents(data.events))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  const usage = [...events]
    .reverse()
    .find((event) => event.type === "turn.completed")
    ?.usage;

  return (
    <main className="min-h-screen bg-[#fafafa] px-4 py-7 text-[#18181b] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider text-[#8b1a1a]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#8b1a1a]" />
              Live Workspace
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#18181b]">
              Codex Agent Monitor
            </h1>
            <p className="mt-1 text-sm text-[#6b7280]">
              Agent trajectory, session persistence, diagnostics, and token usage.
            </p>
          </div>
          <div className="rounded-md border border-[#e5e7eb] bg-white px-3 py-1.5 font-mono text-xs text-[#6b7280]">
            Part 2E · Observability
          </div>
        </header>

        <div className="mb-8">
          <LiveAgentRunner />
        </div>

        {/* Recorded sample trajectory viewer (preserved in matching light theme) */}
        <details className="rounded-xl border border-[#e2e5e9] bg-white p-4">
          <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-[#374151] hover:text-[#18181b]">
            <span className="flex items-center gap-2">
              <span className="italic text-[#6b7280]">recorded sample trajectory</span>
              <span className="rounded-full bg-[#eef0f2] px-2 py-0.5 font-mono text-[11px] text-[#4b5563]">
                {events.length} events
              </span>
            </span>
            {usage && (
              <span className="font-mono text-xs text-[#6b7280]">
                {(usage.input_tokens ?? 0).toLocaleString()} in ·{" "}
                {(usage.cached_input_tokens ?? 0).toLocaleString()} cached ·{" "}
                {(usage.output_tokens ?? 0).toLocaleString()} out
              </span>
            )}
          </summary>

          <div className="mt-4 space-y-4 border-t border-[#e5e7eb] pt-4">
            {loading && (
              <div className="rounded-md border border-[#e5e7eb] bg-[#fafafa] px-3 py-2 text-xs italic text-[#6b7280]">
                Loading recorded trajectory...
              </div>
            )}

            {error && (
              <div className="rounded-md border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-xs text-[#991b1b]">
                Unable to load trajectory: {error}
              </div>
            )}

            {usage && (
              <section className="grid gap-3 sm:grid-cols-3">
                <Metric label="Input tokens" value={usage.input_tokens} />
                <Metric
                  label="Cached tokens"
                  value={usage.cached_input_tokens}
                  accent="text-[#15803d]"
                />
                <Metric
                  label="Output tokens"
                  value={usage.output_tokens}
                  accent="text-[#8b1a1a]"
                />
              </section>
            )}

            <div className="space-y-2.5">
              {events.length === 0 && !loading ? (
                <div className="rounded-lg border border-dashed border-[#e5e7eb] p-6 text-center text-xs italic text-[#9ca3af]">
                  No recorded events yet.
                </div>
              ) : (
                events.map((event, index) => (
                  <article
                    key={index}
                    className="rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3.5"
                  >
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-[#f9ebeb] px-2.5 py-0.5 font-mono text-[11px] font-medium text-[#8b1a1a]">
                          {event.item?.type ?? event.type}
                        </span>
                        <span className="font-mono text-xs text-[#6b7280]">
                          {event.type}
                        </span>
                      </div>
                      {event.item?.status && (
                        <span className="font-mono text-xs text-[#15803d]">
                          {event.item.status === "completed" ? "✓ " : ""}
                          {event.item.status}
                        </span>
                      )}
                    </div>

                    {event.item?.text && (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#18181b]">
                        {event.item.text}
                      </p>
                    )}

                    {event.item?.command && (
                      <details className="mt-2 rounded-md border border-[#e5e7eb] bg-white p-2.5">
                        <summary className="cursor-pointer text-xs italic text-[#6b7280] hover:text-[#18181b]">
                          View command
                        </summary>
                        <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-[#27272a]">
                          {event.item.command}
                        </pre>
                      </details>
                    )}

                    {event.item?.aggregated_output && (
                      <details className="mt-2 rounded-md border border-[#e5e7eb] bg-white p-2.5">
                        <summary className="cursor-pointer text-xs italic text-[#6b7280] hover:text-[#18181b]">
                          View tool output
                        </summary>
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-[#27272a]">
                          {event.item.aggregated_output}
                        </pre>
                      </details>
                    )}
                  </article>
                ))
              )}
            </div>
          </div>
        </details>
      </div>
    </main>
  );
}

// Renders one token-usage summary card.
function Metric({
  label,
  value,
  accent = "text-[#18181b]",
}: {
  label: string;
  value?: number;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3">
      <p className="text-xs text-[#6b7280]">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold tracking-tight ${accent}`}>
        {(value ?? 0).toLocaleString()}
      </p>
    </div>
  );
}
