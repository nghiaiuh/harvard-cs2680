"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionMetadata } from "@/types";
import { aggregateSessions } from "@/lib/trajectory";

type Props = {
  selectedId?: string;
  refreshKey: number;
  onSelect: (threadId: string) => void;
};

export function SessionSidebar({
  selectedId,
  refreshKey,
  onSelect,
}: Props) {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/session")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load sessions");
        return res.json();
      })
      .then((data) => {
        setSessions(data.sessions || []);
        setError("");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Load failed");
      })
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const summary = useMemo(() => aggregateSessions(sessions), [sessions]);

  function renderStatus(status: string) {
    switch (status) {
      case "completed":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#15803d]">
            <span>✓</span> completed
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#b91c1c]">
            <span>✕</span> failed
          </span>
        );
      case "running":
      case "starting":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#b45309]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#d97706] animate-pulse" />
            {status}
          </span>
        );
      case "timed_out":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#b45309]">
            <span>●</span> timed_out
          </span>
        );
      case "cancelled":
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#6b7280]">
            <span>○</span> cancelled
          </span>
        );
      default:
        return (
          <span className="text-[11px] font-medium text-[#6b7280]">{status}</span>
        );
    }
  }

  return (
    <aside className="flex flex-col gap-3 rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3.5">
      <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2.5">
        <h2 className="text-xs font-medium italic text-[#6b7280]">sessions</h2>
        <span className="rounded-full bg-[#eef0f2] px-2 py-0.5 font-mono text-[11px] text-[#374151]">
          {sessions.length}
        </span>
      </div>

      {sessions.length > 0 && (
        <div className="rounded-md border border-[#e5e7eb] bg-white px-2.5 py-2 font-mono text-[11px] text-[#6b7280]">
          <div className="flex justify-between">
            <span>all tokens</span>
            <span className="font-medium text-[#18181b]">
              {(summary.totalInput + summary.totalOutput).toLocaleString()}
            </span>
          </div>
          <div className="mt-0.5 flex justify-between">
            <span>total cost</span>
            <span className="font-semibold text-[#8b1a1a]">
              {summary.formattedTotalCost}
            </span>
          </div>
          <div className="mt-0.5 flex justify-between">
            <span>turns · tools</span>
            <span className="text-[#374151]">
              {summary.totalTurns}t · {summary.totalToolCalls}
              {summary.totalToolErrors > 0 ? (
                <span className="text-[#b91c1c]"> ({summary.totalToolErrors}e)</span>
              ) : null}
            </span>
          </div>
        </div>
      )}

      {loading && sessions.length === 0 && (
        <p className="text-xs italic text-[#6b7280]">Loading sessions...</p>
      )}

      {error && (
        <p className="rounded-md border border-[#fecaca] bg-[#fef2f2] px-2.5 py-1.5 text-xs text-[#991b1b]" role="alert">
          {error}
        </p>
      )}

      {sessions.length === 0 && !loading && (
        <p className="text-xs italic text-[#9ca3af]">No saved sessions yet.</p>
      )}

      <div className="max-h-[680px] space-y-2 overflow-y-auto pr-0.5">
        {sessions.map((session) => {
          const isSelected = selectedId === session.threadId;
          const totalTokens =
            session.totalTokens ??
            (session.inputTokens ?? 0) + (session.outputTokens ?? 0);
          const toolCalls = session.toolCallsCount ?? 0;
          const toolErrors = session.toolErrorsCount ?? 0;

          return (
            <button
              key={session.threadId}
              onClick={() => onSelect(session.threadId)}
              className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                isSelected
                  ? "border-[#8b1a1a]/60 bg-[#fdf7f7] ring-1 ring-[#8b1a1a]/20"
                  : "border-[#e5e7eb] bg-white hover:border-[#d1d5db] hover:bg-[#fcfcfc]"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[#18181b]">
                  {session.title || "Untitled session"}
                </p>
              </div>

              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span
                  className="font-mono text-[11px] text-[#8b1a1a]"
                  title={session.threadId}
                >
                  {session.threadId.slice(0, 8)}-...
                </span>
                {renderStatus(session.status)}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-[#6b7280]">
                <span>{session.turns}t</span>
                <span>·</span>
                <span>{totalTokens ? `${totalTokens.toLocaleString()} tok` : "—"}</span>
                {session.costFormatted && (
                  <>
                    <span>·</span>
                    <span className="font-semibold text-[#8b1a1a]">{session.costFormatted}</span>
                  </>
                )}
                <span>·</span>
                <span>
                  {toolCalls} tool{toolCalls === 1 ? "" : "s"}
                  {toolErrors > 0 ? (
                    <span className="text-[#b91c1c]"> ({toolErrors} err)</span>
                  ) : null}
                </span>
                {session.durationMs !== undefined && (
                  <>
                    <span>·</span>
                    <span>{Math.round(session.durationMs / 1000)}s</span>
                  </>
                )}
              </div>

              <div className="mt-1.5 flex justify-between text-[10px] text-[#9ca3af]">
                <span title={`Created: ${new Date(session.createdAt).toLocaleString()}`}>
                  {new Date(session.createdAt).toLocaleDateString()}
                </span>
                <span title={`Updated: ${new Date(session.updatedAt).toLocaleString()}`}>
                  {new Date(session.updatedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
