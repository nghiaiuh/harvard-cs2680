"use client";

import { useEffect, useState, useMemo } from "react";
import { useAgentStream } from "@/hooks/use-agent-stream";
import type { AgentEvent } from "@/hooks/use-agent-stream";
import { SessionSidebar } from "./session-sidebar";
import {
  aggregateUsage,
  normalizeTrajectory,
  getTurnUsageBreakdown,
  extractDiagnostics,
  buildSubagentTree,
} from "@/lib/trajectory";
import { calculateRunCost, DEFAULT_MODEL } from "@/lib/pricing";
import type { AgentItem, DiagnosticItem, SessionMetadata } from "@/types";

function getToolLabel(item: AgentItem, eventType: string): {
  label: string;
  tone: "tool" | "task" | "user" | "message";
} {
  if (item.type === "task" || item.type === "subagent") {
    return { label: "Task", tone: "task" };
  }

  if (item.type === "file_change" || (item.changes && item.changes.length > 0)) {
    const firstKind = item.changes?.[0]?.kind;
    if (firstKind === "create") return { label: "Create", tone: "tool" };
    if (firstKind === "delete") return { label: "Delete", tone: "tool" };
    return { label: "Edit", tone: "tool" };
  }

  if (item.type === "command_execution" || item.command !== undefined) {
    const cmd = (item.command ?? "").toLowerCase();
    if (cmd.includes("rg ") || cmd.includes("grep") || cmd.includes("select-string")) {
      return { label: "Grep", tone: "tool" };
    }
    if (
      (cmd.includes("get-content") || cmd.includes("cat ")) &&
      !cmd.includes("npm ") &&
      !cmd.includes("node ")
    ) {
      return { label: "Read", tone: "tool" };
    }
    if (cmd.includes("get-childitem") || cmd.includes("glob") || cmd.includes("find ")) {
      return { label: "Glob", tone: "tool" };
    }
    return { label: "Bash", tone: "tool" };
  }

  if (item.type === "system_event") {
    if (eventType === "turn.failed" || eventType === "error") {
      return { label: "Error", tone: "tool" };
    }
    return { label: "Event", tone: "task" };
  }

  return { label: "Reply", tone: "message" };
}

function summarizeCommand(command: string): string {
  const cleaned = command
    .replace(/^"[^"]*powershell\.exe"\s+-Command\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  if (cleaned.length <= 84) return cleaned;
  return cleaned.slice(0, 81) + "...";
}

function formatStatusText(status: string) {
  switch (status) {
    case "completed":
      return { icon: "✓", text: "finished", color: "text-[#15803d]" };
    case "running":
      return { icon: "●", text: "running", color: "text-[#b45309]" };
    case "starting":
      return { icon: "●", text: "starting", color: "text-[#b45309]" };
    case "failed":
      return { icon: "✕", text: "failed", color: "text-[#b91c1c]" };
    case "cancelled":
      return { icon: "○", text: "cancelled", color: "text-[#6b7280]" };
    case "timed_out":
      return { icon: "●", text: "timed_out", color: "text-[#b45309]" };
    default:
      return { icon: "", text: "idle", color: "text-[#9ca3af]" };
  }
}

export function LiveAgentRunner() {
  const [prompt, setPrompt] = useState(
    "Inspect calculator.js and calculator.test.js. " +
      "Run npm test and explain the results. " +
      "Do not modify files."
  );
  const [submittedPrompt, setSubmittedPrompt] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [selectedMetadata, setSelectedMetadata] = useState<SessionMetadata | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [history, setHistory] = useState<AgentEvent[]>([]);
  const [showLiveEvents, setShowLiveEvents] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showSystemEvents, setShowSystemEvents] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [foldedTurns, setFoldedTurns] = useState<Record<number, boolean>>({});
  const [collapsedTasks, setCollapsedTasks] = useState<Record<string, boolean>>({});
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});
  const [sessionError, setSessionError] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const {
    events,
    status,
    error,
    warnings,
    diagnostics: streamDiagnostics,
    run,
    cancel,
    startedAt,
    endedAt,
    durationMs,
    resetForSession,
  } = useAgentStream();

  async function selectSession(threadId: string) {
    if (status === "running" || status === "starting") return;

    try {
      const response = await fetch(`/api/session/${threadId}`);
      if (!response.ok) {
        throw new Error(`Failed to load session (HTTP ${response.status})`);
      }

      const data = await response.json();
      setSelectedId(threadId);
      setSelectedMetadata(data.metadata);
      setSubmittedPrompt(data.metadata?.title ?? "");
      setHistory(data.events || []);
      setShowLiveEvents(false);
      setFoldedTurns({});
      setCollapsedTasks({});
      setExpandedOutputs({});
      setSessionError("");

      resetForSession(data.metadata, data.events || []);
    } catch (err) {
      setSessionError(
        err instanceof Error ? err.message : "Failed to load session history."
      );
    }
  }

  // Timer for measuring live elapsed time
  useEffect(() => {
    if (status !== "running" && status !== "starting") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [status]);

  // Refresh sidebar when execution finishes
  useEffect(() => {
    if (
      status !== "completed" &&
      status !== "failed" &&
      status !== "cancelled" &&
      status !== "timed_out"
    )
      return;

    const refreshTimer = window.setTimeout(() => {
      setRefreshKey((value) => value + 1);
    }, 200);

    return () => window.clearTimeout(refreshTimer);
  }, [status]);

  const threadId =
    selectedId ??
    (showLiveEvents ? events : []).find(
      (event) => event.type === "thread.started"
    )?.thread_id;

  const visibleEvents = useMemo(() => {
    return [...history, ...(showLiveEvents ? events : [])];
  }, [history, showLiveEvents, events]);

  const totals = useMemo(() => aggregateUsage(visibleEvents), [visibleEvents]);

  const activeModel = selectedMetadata?.model || DEFAULT_MODEL;

  const runCost = useMemo(() => {
    return calculateRunCost(totals, activeModel);
  }, [totals, activeModel]);

  const turnBreakdown = useMemo(
    () => getTurnUsageBreakdown(visibleEvents, activeModel),
    [visibleEvents, activeModel]
  );

  const normalizedItems = useMemo(() => {
    return normalizeTrajectory(visibleEvents, {
      includeSystemEvents: showSystemEvents,
    });
  }, [visibleEvents, showSystemEvents]);

  const filteredTimeline = useMemo(() => {
    return normalizedItems.filter(({ item, eventType }) => {
      const textToSearch = `${eventType} ${item.type ?? ""} ${item.command ?? ""} ${
        item.text ?? ""
      } ${item.aggregated_output ?? ""} ${
        item.changes?.map((c) => c.path).join(" ") ?? ""
      }`;

      const matchesSearch = textToSearch
        .toLowerCase()
        .includes(search.toLowerCase());
      const matchesType =
        !typeFilter || item.type === typeFilter || eventType === typeFilter;
      const matchesStatus = !statusFilter || item.status === statusFilter;

      return matchesSearch && matchesType && matchesStatus;
    });
  }, [normalizedItems, search, typeFilter, statusFilter]);

  // Structured turn groups with subagent tasks tree
  const structuredTurns = useMemo(() => {
    return buildSubagentTree(filteredTimeline);
  }, [filteredTimeline]);

  const combinedDiagnostics = useMemo(() => {
    const list: DiagnosticItem[] = [...streamDiagnostics];
    const extracted = extractDiagnostics(visibleEvents);
    for (const d of extracted) {
      if (
        !list.some(
          (existing) =>
            existing.category === d.category &&
            existing.turn === d.turn &&
            existing.itemId === d.itemId
        )
      ) {
        list.push(d);
      }
    }
    return list;
  }, [streamDiagnostics, visibleEvents]);

  const displayedDurationSec = useMemo(() => {
    if (status === "running" || status === "starting") {
      if (!startedAt) return 0;
      const current = now || startedAt;
      return Math.max(0, Math.floor((current - startedAt) / 1000));
    }
    if (durationMs !== undefined) {
      return Math.max(0, Math.round(durationMs / 1000));
    }
    if (startedAt && endedAt) {
      return Math.max(0, Math.round((endedAt - startedAt) / 1000));
    }
    if (selectedMetadata?.durationMs !== undefined) {
      return Math.max(0, Math.round(selectedMetadata.durationMs / 1000));
    }
    return undefined;
  }, [status, startedAt, endedAt, durationMs, selectedMetadata, now]);

  async function handleCopy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(`Copied ${label}`);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback("Copy failed");
      setTimeout(() => setCopyFeedback(null), 2000);
    }
  }

  function handleRun() {
    if (status === "running" || status === "starting" || !prompt.trim()) return;
    if (showLiveEvents && selectedId) {
      setHistory((previous) => [...previous, ...events]);
    }
    setSubmittedPrompt(prompt.trim());
    setShowLiveEvents(true);
    run(prompt, selectedId);
  }

  function scrollToElement(elementId: string) {
    const el = document.getElementById(elementId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  const statusMeta = formatStatusText(status);
  const isRunning = status === "running" || status === "starting";
  const displayTitle = submittedPrompt || selectedMetadata?.title || "";

  // Helper renderer for a single timeline action item
  function renderActionItem(entry: (typeof filteredTimeline)[number], uniqueKey: string) {
    const { item, eventType } = entry;
    const isCommand = item.type === "command_execution" || item.command !== undefined;
    const isFileChange = item.type === "file_change" || (item.changes && item.changes.length > 0);
    const isSystemEvent = item.type === "system_event";
    const isAgentMessage =
      item.type === "agent_message" ||
      (!isCommand && !isFileChange && !isSystemEvent && item.text);

    const pill = getToolLabel(item, eventType);
    const isOutputExpanded = Boolean(expandedOutputs[uniqueKey]);

    const outputLines = (item.aggregated_output ?? "").split(/\r?\n/);
    const previewLimit = 4;
    const hasMoreLines = outputLines.length > previewLimit;
    const previewOutput = isOutputExpanded
      ? item.aggregated_output ?? ""
      : outputLines.slice(0, previewLimit).join("\n");

    const failed =
      item.status === "failed" || (item.exit_code != null && item.exit_code !== 0);
    const inProgress = item.status === "in_progress";

    return (
      <article key={uniqueKey} id={uniqueKey} className="space-y-2 scroll-mt-6">
        {/* Agent Message: editorial prose */}
        {isAgentMessage && item.text && (
          <p className="text-[15px] leading-relaxed text-[#18181b] whitespace-pre-wrap">
            {item.text}
          </p>
        )}

        {/* System / Turn Event */}
        {isSystemEvent && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="shrink-0 rounded-full bg-[#ebf3fe] px-2.5 py-0.5 text-xs font-medium text-[#1d4ed8]">
                {pill.label}
              </span>
              <span className="truncate font-mono text-xs text-[#6b7280]">
                {item.text || eventType}
              </span>
            </div>
            <span className={`text-xs ${failed ? "text-[#b91c1c]" : "text-[#15803d]"}`}>
              {failed ? "✕" : "✓"}
            </span>
          </div>
        )}

        {/* File Change Row */}
        {isFileChange && item.changes && (
          <div className="space-y-1.5">
            {item.changes.map((change, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="shrink-0 rounded-full bg-[#f9ebeb] px-2.5 py-0.5 text-xs font-medium text-[#8b1a1a]">
                    {change.kind === "create"
                      ? "Create"
                      : change.kind === "delete"
                      ? "Delete"
                      : "Edit"}
                  </span>
                  <span className="truncate font-mono text-[13px] text-[#18181b]">
                    {change.path}
                  </span>
                </div>
                <span className="shrink-0 text-xs font-medium">
                  {inProgress ? (
                    <span className="inline-flex items-center gap-1 text-[#b45309]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#d97706] animate-pulse" />
                      pending
                    </span>
                  ) : failed ? (
                    <span className="text-[#b91c1c]">✕</span>
                  ) : (
                    <span className="text-[#15803d]">✓</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Command Execution Row + Folded Code Box */}
        {isCommand && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="shrink-0 rounded-full bg-[#f9ebeb] px-2.5 py-0.5 text-xs font-medium text-[#8b1a1a]">
                  {pill.label}
                </span>
                <code
                  className="truncate font-mono text-[13px] text-[#18181b]"
                  title={item.command}
                >
                  {item.command ? summarizeCommand(item.command) : "command"}
                </code>
              </div>

              <div className="flex shrink-0 items-center gap-2.5 text-xs">
                {item.command && (
                  <button
                    type="button"
                    onClick={() => handleCopy(item.command ?? "", "command")}
                    className="text-[11px] text-[#9ca3af] hover:text-[#374151]"
                  >
                    copy
                  </button>
                )}
                {inProgress ? (
                  <span className="inline-flex items-center gap-1 font-medium text-[#b45309]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#d97706] animate-pulse" />
                    pending
                  </span>
                ) : failed ? (
                  <span className="font-mono font-medium text-[#b91c1c]">
                    ✕ exit {item.exit_code ?? "?"}
                  </span>
                ) : (
                  <span className="font-medium text-[#15803d]">✓</span>
                )}
              </div>
            </div>

            {(item.aggregated_output || (item.command && item.command.length > 84)) && (
              <div
                className={`ml-2 rounded-md border p-3 font-mono text-xs ${
                  failed
                    ? "border-[#fecaca] bg-[#fef2f2]/50 text-[#7f1d1d]"
                    : "border-[#e5e7eb] bg-[#fbfbfc] text-[#27272a]"
                }`}
              >
                {item.command && item.command.length > 84 && (
                  <details className="mb-2 border-b border-[#e5e7eb] pb-2">
                    <summary className="cursor-pointer font-sans text-[11px] italic text-[#6b7280] hover:text-[#18181b]">
                      full command
                    </summary>
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap text-[11px] text-[#374151]">
                      {item.command}
                    </pre>
                  </details>
                )}

                {item.aggregated_output && (
                  <>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap leading-relaxed">
                      {previewOutput}
                    </pre>

                    <div className="mt-2 flex items-center justify-between gap-2 pt-1 font-sans">
                      {hasMoreLines ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedOutputs((prev) => ({
                              ...prev,
                              [uniqueKey]: !prev[uniqueKey],
                            }))
                          }
                          className="text-xs italic text-[#6b7280] hover:text-[#18181b]"
                        >
                          {isOutputExpanded
                            ? "▾ collapse output"
                            : `▸ ${outputLines.length - previewLimit} more lines, folded`}
                        </button>
                      ) : (
                        <span />
                      )}

                      <button
                        type="button"
                        onClick={() => handleCopy(item.aggregated_output ?? "", "output")}
                        className="text-[11px] text-[#6b7280] hover:text-[#18181b]"
                      >
                        Copy output
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </article>
    );
  }

  return (
    <section className="grid gap-4 rounded-xl border border-[#e2e5e9] bg-white p-4 text-[#18181b] shadow-[0_1px_2px_rgba(0,0,0,0.03)] lg:grid-cols-[240px_1fr_180px]">
      {/* Left Rail: Saved Sessions */}
      <SessionSidebar
        selectedId={selectedId}
        refreshKey={refreshKey}
        onSelect={(id) => {
          selectSession(id);
        }}
      />

      {/* Center Column: Trajectory, Subagent Tree & Prompt Runner */}
      <div className="flex min-w-0 flex-col justify-between gap-5 px-1 sm:px-2">
        <div className="space-y-5">
          {/* Top working directory bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e5e7eb] pb-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-sm text-[#6b7280]">working directory</span>
              <code className="rounded-md border border-[#e5e7eb] bg-[#f9fafb] px-3 py-1 font-mono text-[13px] text-[#18181b]">
                ../sandbox
              </code>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowFilters((v) => !v)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  showFilters || search || typeFilter || statusFilter
                    ? "border-[#8b1a1a]/40 bg-[#fdf7f7] text-[#8b1a1a]"
                    : "border-[#e5e7eb] bg-white text-[#4b5563] hover:bg-[#f9fafb]"
                }`}
              >
                Filter
              </button>
              <button
                type="button"
                onClick={() => setShowAnalytics((v) => !v)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  showAnalytics
                    ? "border-[#8b1a1a]/40 bg-[#fdf7f7] text-[#8b1a1a]"
                    : "border-[#e5e7eb] bg-white text-[#4b5563] hover:bg-[#f9fafb]"
                }`}
              >
                Cost & Tokens
              </button>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => {
                  setSelectedId(undefined);
                  setSelectedMetadata(null);
                  setSubmittedPrompt("");
                  setHistory([]);
                  setShowLiveEvents(false);
                  setFoldedTurns({});
                  setCollapsedTasks({});
                  setSessionError("");
                }}
                className="rounded-md border border-[#e5e7eb] bg-white px-2.5 py-1 text-xs font-medium text-[#374151] hover:bg-[#f9fafb] disabled:opacity-50"
              >
                + New session
              </button>
            </div>
          </div>

          {/* Active / Selected Session Prompt Header */}
          {(displayTitle || threadId || status !== "idle") && (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-baseline gap-2.5 min-w-0">
                  <span className="shrink-0 rounded-full bg-[#eef0f2] px-2.5 py-0.5 text-xs font-medium text-[#374151]">
                    You
                  </span>
                  <p className="text-[15px] leading-snug text-[#18181b] break-words">
                    {displayTitle || "Active agent session"}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
                  <span className={`inline-flex items-center gap-1 ${statusMeta.color}`}>
                    {statusMeta.icon && (
                      <span className={isRunning ? "animate-pulse" : ""}>
                        {statusMeta.icon}
                      </span>
                    )}
                    <span>{statusMeta.text}</span>
                  </span>
                </div>
              </div>

              {threadId && (
                <div className="flex flex-wrap items-center gap-2 pl-[46px] font-mono text-xs text-[#6b7280]">
                  <span>{selectedId ? "resumed session" : "session"}</span>
                  <span className="text-[#8b1a1a]" title={threadId}>
                    {threadId.slice(0, 8)}-...
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(threadId, "Session ID")}
                    className="text-[11px] text-[#9ca3af] underline decoration-dotted hover:text-[#374151]"
                  >
                    copy id
                  </button>
                  {copyFeedback && (
                    <span className="text-[11px] text-[#15803d]">✓ {copyFeedback}</span>
                  )}
                </div>
              )}

              {/* Exact reference style metrics bar: $0.58 · 42 s · 12 turns · session_id fe891e8a-... */}
              {(displayedDurationSec !== undefined ||
                totals.turns > 0 ||
                totals.input > 0 ||
                threadId) && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-[46px] font-mono text-xs text-[#6b7280]">
                  <span
                    className="font-semibold text-[#8b1a1a]"
                    title={`Model: ${activeModel} (Estimated USD cost)`}
                  >
                    {runCost.formattedCost}
                  </span>
                  <span>·</span>
                  {displayedDurationSec !== undefined && (
                    <>
                      <span>{displayedDurationSec} s</span>
                      <span>·</span>
                    </>
                  )}
                  <span>
                    {totals.turns} turn{totals.turns === 1 ? "" : "s"}
                  </span>
                  {totals.input + totals.output > 0 && (
                    <>
                      <span>·</span>
                      <span>{totals.input.toLocaleString()} in</span>
                      <span>({totals.cached.toLocaleString()} c)</span>
                      <span>·</span>
                      <span>{totals.output.toLocaleString()} out</span>
                    </>
                  )}
                  {totals.reasoning !== undefined && totals.reasoning > 0 && (
                    <>
                      <span>·</span>
                      <span>{totals.reasoning.toLocaleString()} r</span>
                    </>
                  )}
                  {threadId && (
                    <>
                      <span>·</span>
                      <span>
                        session_id{" "}
                        <span className="text-[#8b1a1a]">{threadId.slice(0, 8)}-...</span>
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Diagnostics & Errors */}
          {(error ||
            sessionError ||
            combinedDiagnostics.length > 0 ||
            warnings.length > 0) && (
            <div className="space-y-2 rounded-lg border border-[#fecaca] bg-[#fef2f2]/70 p-3.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#991b1b]">
                  Diagnostics
                </span>
                <span className="font-mono text-[11px] text-[#7f1d1d]/70">
                  {combinedDiagnostics.length + warnings.length} item(s)
                </span>
              </div>

              {error && (
                <p className="text-xs font-medium text-[#991b1b]">
                  Execution error: {error}
                </p>
              )}

              {sessionError && (
                <p className="text-xs text-[#991b1b]" role="alert">
                  Session error: {sessionError}
                </p>
              )}

              {warnings.map((w, idx) => (
                <p key={idx} className="text-xs text-[#b45309]">
                  Warning: {w}
                </p>
              ))}

              {combinedDiagnostics.map((diag, index) => (
                <div
                  key={index}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    diag.severity === "error"
                      ? "border-[#fca5a5] bg-white text-[#991b1b]"
                      : diag.severity === "warning"
                      ? "border-[#fcd34d] bg-[#fffbeb] text-[#92400e]"
                      : "border-[#e5e7eb] bg-white text-[#4b5563]"
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="font-semibold">
                      [{diag.category}]{diag.turn ? ` · turn ${diag.turn}` : ""}
                    </span>
                    <span className="opacity-75">{diag.severity}</span>
                  </div>
                  <p className="mt-1">{diag.message}</p>
                  {diag.details && (
                    <pre className="mt-1.5 overflow-x-auto rounded border border-[#e5e7eb] bg-[#f9fafb] p-2 font-mono text-[11px] text-[#374151]">
                      {diag.details}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Collapsible Filter Toolbar */}
          {showFilters && (
            <div className="space-y-2.5 rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  aria-label="Search timeline"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search commands, outputs, files, or messages..."
                  className="flex-1 rounded-md border border-[#d1d5db] bg-white px-3 py-1.5 text-xs text-[#18181b] placeholder:italic placeholder:text-[#9ca3af] focus:border-[#8b1a1a] focus:outline-none"
                />
                <select
                  aria-label="Filter type"
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                  className="rounded-md border border-[#d1d5db] bg-white px-2.5 py-1.5 text-xs text-[#374151] focus:border-[#8b1a1a] focus:outline-none"
                >
                  <option value="">All types</option>
                  <option value="task">task (subagent)</option>
                  <option value="agent_message">agent_message</option>
                  <option value="command_execution">command_execution</option>
                  <option value="file_change">file_change</option>
                  <option value="system_event">system_event</option>
                </select>
                <select
                  aria-label="Filter status"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="rounded-md border border-[#d1d5db] bg-white px-2.5 py-1.5 text-xs text-[#374151] focus:border-[#8b1a1a] focus:outline-none"
                >
                  <option value="">All statuses</option>
                  <option value="completed">completed</option>
                  <option value="in_progress">in_progress</option>
                  <option value="failed">failed</option>
                </select>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-[#6b7280] cursor-pointer">
                <input
                  type="checkbox"
                  checked={showSystemEvents}
                  onChange={(e) => setShowSystemEvents(e.target.checked)}
                  className="rounded border-[#d1d5db] accent-[#8b1a1a]"
                />
                Show turn & system boundary events
              </label>
            </div>
          )}

          {/* Collapsible Token Analytics & Run Cost Breakdown */}
          {showAnalytics && totals.input + totals.output > 0 && (
            <div className="space-y-3 rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3.5">
              <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[#18181b]">Cost & Usage Analytics</span>
                  <span className="rounded bg-[#f9ebeb] px-2 py-0.5 font-mono text-[11px] font-semibold text-[#8b1a1a]">
                    Model: {activeModel}
                  </span>
                </div>
                <span className="font-mono text-xs font-bold text-[#8b1a1a]">
                  Total Run Cost: {runCost.formattedCost}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <MetricCard
                  label="Total Input"
                  value={totals.input}
                  subtext={`$${runCost.breakdown.inputCost.toFixed(4)}`}
                />
                <MetricCard
                  label="Cached Input"
                  value={totals.cached}
                  accent="text-[#15803d]"
                  subtext={`$${runCost.breakdown.cachedCost.toFixed(4)}`}
                />
                <MetricCard
                  label="Non-Cached"
                  value={totals.nonCached}
                  accent="text-[#1d4ed8]"
                />
                <MetricCard
                  label="Total Output"
                  value={totals.output}
                  accent="text-[#8b1a1a]"
                  subtext={`$${runCost.breakdown.outputCost.toFixed(4)}`}
                />
              </div>

              {totals.reasoning !== undefined && totals.reasoning > 0 && (
                <div className="flex items-center justify-between rounded-md border border-[#e5e7eb] bg-white px-3 py-1.5 font-mono text-xs">
                  <span className="text-[#6b7280]">reasoning_output_tokens</span>
                  <span className="font-semibold text-[#18181b]">
                    {totals.reasoning.toLocaleString()}
                  </span>
                </div>
              )}

              {/* Stacked distribution bars */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="flex justify-between font-mono text-[11px] text-[#6b7280]">
                    <span>
                      input {Math.round((totals.input / (totals.input + totals.output)) * 100)}%
                    </span>
                    <span>
                      output {Math.round((totals.output / (totals.input + totals.output)) * 100)}%
                    </span>
                  </div>
                  <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#e5e7eb]">
                    <div
                      style={{
                        width: `${(totals.input / (totals.input + totals.output)) * 100}%`,
                      }}
                      className="bg-[#374151] transition-all duration-300"
                    />
                    <div
                      style={{
                        width: `${(totals.output / (totals.input + totals.output)) * 100}%`,
                      }}
                      className="bg-[#8b1a1a] transition-all duration-300"
                    />
                  </div>
                </div>

                {totals.input > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between font-mono text-[11px] text-[#6b7280]">
                      <span className="text-[#15803d]">
                        cached {Math.round((totals.cached / totals.input) * 100)}%
                      </span>
                      <span className="text-[#1d4ed8]">
                        fresh {Math.round((totals.nonCached / totals.input) * 100)}%
                      </span>
                    </div>
                    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#e5e7eb]">
                      <div
                        style={{ width: `${(totals.cached / totals.input) * 100}%` }}
                        className="bg-[#15803d] transition-all duration-300"
                      />
                      <div
                        style={{
                          width: `${(totals.nonCached / totals.input) * 100}%`,
                        }}
                        className="bg-[#2563eb] transition-all duration-300"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Per-Turn Breakdown with Turn Cost */}
              {turnBreakdown.length > 1 && (
                <div className="border-t border-[#e5e7eb] pt-2.5">
                  <span className="text-[11px] italic text-[#6b7280]">
                    per-turn token & cost breakdown
                  </span>
                  <div className="mt-1.5 space-y-1.5">
                    {turnBreakdown.map((tb) => {
                      const maxTokens = Math.max(
                        ...turnBreakdown.map((b) => b.input + b.output),
                        1
                      );
                      const turnTotal = tb.input + tb.output;
                      const widthPercent = Math.max(
                        6,
                        Math.round((turnTotal / maxTokens) * 100)
                      );

                      return (
                        <div
                          key={tb.turn}
                          className="flex items-center gap-2 font-mono text-[11px]"
                        >
                          <span className="w-10 shrink-0 text-[#6b7280]">
                            T{tb.turn}
                          </span>
                          <div className="h-3.5 flex-1 overflow-hidden rounded bg-[#e5e7eb]">
                            <div
                              style={{ width: `${widthPercent}%` }}
                              className="flex h-full items-center bg-[#8b1a1a]/85 px-1.5 text-[10px] font-medium text-white"
                            >
                              {turnTotal.toLocaleString()}
                            </div>
                          </div>
                          <span className="w-16 text-right font-semibold text-[#8b1a1a]">
                            {tb.costFormatted}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Main Trajectory Timeline + Subagent Tree */}
          <div className="space-y-5 border-t border-[#e5e7eb] pt-4">
            {structuredTurns.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#e5e7eb] py-10 text-center text-sm italic text-[#9ca3af]">
                {visibleEvents.length === 0
                  ? "No trajectory events yet. Enter a prompt below and click Run."
                  : "No timeline items match the active filter."}
              </div>
            ) : (
              structuredTurns.map((group, groupIdx) => {
                const isFolded = Boolean(foldedTurns[group.turn]);
                const turnUsage = turnBreakdown.find((b) => b.turn === group.turn);
                const totalTurnItems =
                  group.rootItems.length +
                  group.tasks.reduce((sum, t) => sum + t.items.length + 1, 0);

                return (
                  <div
                    key={group.turn}
                    id={`turn-section-${group.turn}`}
                    className={groupIdx > 0 ? "border-t border-[#e5e7eb] pt-5" : ""}
                  >
                    {/* Turn header & fold toggle */}
                    <div className="mb-3 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() =>
                          setFoldedTurns((prev) => ({
                            ...prev,
                            [group.turn]: !prev[group.turn],
                          }))
                        }
                        className="inline-flex items-center gap-1.5 text-xs italic text-[#6b7280] hover:text-[#18181b]"
                      >
                        <span className="text-[10px]">{isFolded ? "▸" : "▾"}</span>
                        <span>
                          turn {group.turn} · {totalTurnItems} event
                          {totalTurnItems === 1 ? "" : "s"}
                          {isFolded ? ", folded" : ""}
                        </span>
                      </button>

                      {turnUsage && (
                        <div className="flex items-center gap-2 font-mono text-[11px] text-[#9ca3af]">
                          <span className="font-semibold text-[#8b1a1a]">
                            {turnUsage.costFormatted}
                          </span>
                          <span>·</span>
                          <span>
                            {turnUsage.input.toLocaleString()} in ·{" "}
                            {turnUsage.output.toLocaleString()} out
                          </span>
                        </div>
                      )}
                    </div>

                    {!isFolded && (
                      <div className="space-y-3.5">
                        {/* 1. Root items in turn before/between tasks */}
                        {group.rootItems.map((entry, idx) =>
                          renderActionItem(entry, `root-${group.turn}-${idx}`)
                        )}

                        {/* 2. Subagent Tasks Section (Hierarchical Subagent Tree) */}
                        {group.tasks.length > 0 && (
                          <div className="my-3 space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="rounded-full bg-[#ebf3fe] px-2.5 py-0.5 text-xs font-semibold text-[#1d4ed8]">
                                Tasks
                              </span>
                            </div>

                            <div className="space-y-3 border-l-2 border-[#e5e7eb] pl-4 ml-3">
                              {group.tasks.map((task) => {
                                const isCollapsed = Boolean(collapsedTasks[task.id]);

                                return (
                                  <div key={task.id} className="space-y-2">
                                    <div className="flex items-center justify-between">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setCollapsedTasks((prev) => ({
                                            ...prev,
                                            [task.id]: !prev[task.id],
                                          }))
                                        }
                                        className="flex items-center gap-2 text-left hover:text-[#8b1a1a]"
                                      >
                                        <span className="text-xs text-[#6b7280]">
                                          {isCollapsed ? "▸" : "▾"}
                                        </span>
                                        <span className="rounded-full bg-[#ebf3fe] px-2 py-0.5 text-[11px] font-semibold text-[#1d4ed8]">
                                          Task
                                        </span>
                                        <span className="text-sm font-medium text-[#18181b]">
                                          {task.title}
                                        </span>
                                        {isCollapsed && (
                                          <span className="text-xs italic text-[#9ca3af]">
                                            · {task.items.length} events collapsed
                                          </span>
                                        )}
                                      </button>

                                      <span className="text-xs">
                                        {task.status === "in_progress" ? (
                                          <span className="inline-flex items-center gap-1 text-[#b45309]">
                                            <span className="h-1.5 w-1.5 rounded-full bg-[#d97706] animate-pulse" />
                                            pending
                                          </span>
                                        ) : task.status === "failed" ? (
                                          <span className="text-[#b91c1c]">✕</span>
                                        ) : (
                                          <span className="text-[#15803d]">✓</span>
                                        )}
                                      </span>
                                    </div>

                                    {/* Subagent Task nested actions */}
                                    {!isCollapsed && task.items.length > 0 && (
                                      <div className="space-y-2 border-l border-[#f1f3f5] pl-3 ml-2">
                                        {task.items.map((subEntry, subIdx) =>
                                          renderActionItem(
                                            subEntry,
                                            `subtask-${task.id}-${subIdx}`
                                          )
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Bottom Prompt Input Bar */}
        <div className="border-t border-[#e5e7eb] pt-4">
          <div className="flex items-stretch gap-2.5">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  handleRun();
                }
              }}
              disabled={isRunning}
              maxLength={4000}
              rows={2}
              placeholder={selectedId ? "type a follow-up..." : "type a prompt..."}
              className="flex-1 resize-none rounded-md border border-[#d1d5db] bg-white px-3.5 py-2.5 text-sm text-[#18181b] placeholder:italic placeholder:text-[#9ca3af] focus:border-[#8b1a1a] focus:outline-none focus:ring-1 focus:ring-[#8b1a1a]/30 disabled:bg-[#f9fafb] disabled:opacity-70"
            />

            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={handleRun}
                disabled={isRunning || !prompt.trim()}
                className="flex-1 rounded-md bg-[#8b1a1a] px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#731414] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isRunning ? "Running..." : "Run"}
              </button>

              {isRunning && (
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-md border border-[#8b1a1a] bg-[#fdf2f2] px-4 py-1 text-xs font-semibold text-[#8b1a1a] transition-colors hover:bg-[#fae8e8]"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-[#9ca3af]">
            Press <kbd className="font-mono">Ctrl+Enter</kbd> to run ·{" "}
            {selectedId ? "Resuming selected session" : "Starts a new session"}
          </p>
        </div>
      </div>

      {/* Right Rail: Visual Outline Tree with Subagent Branching */}
      <aside className="flex flex-col rounded-lg border border-[#e5e7eb] bg-[#fafafa] p-3">
        <div className="mb-3 text-xs italic text-[#9ca3af]">outline</div>

        <div className="flex max-h-[680px] flex-col items-center overflow-y-auto py-1">
          {structuredTurns.length === 0 ? (
            <p className="py-6 text-center text-[11px] italic text-[#9ca3af]">empty</p>
          ) : (
            structuredTurns.map((st, tIdx) => (
              <div key={st.turn} className="flex flex-col items-center w-full">
                {tIdx > 0 && <div className="h-2.5 w-px bg-[#d1d5db]" />}
                {/* User Prompt Node */}
                <button
                  type="button"
                  onClick={() => scrollToElement(`turn-section-${st.turn}`)}
                  className="min-w-[66px] rounded-full border border-transparent bg-[#eef0f2] px-3 py-0.5 text-center text-[11px] font-medium text-[#374151] hover:scale-105"
                >
                  You
                </button>

                {/* Root Items in this turn */}
                {st.rootItems
                  .filter((entry) => {
                    const { item } = entry;
                    return item.type !== "agent_message" || item.command || item.changes?.length;
                  })
                  .map((entry, idx) => {
                    const label = getToolLabel(entry.item, entry.eventType).label;
                    return (
                      <div key={idx} className="flex flex-col items-center">
                        <div className="h-2.5 w-px bg-[#d1d5db]" />
                        <button
                          type="button"
                          onClick={() => scrollToElement(`root-${st.turn}-${idx}`)}
                          className="min-w-[66px] rounded-full border border-transparent bg-[#f9ebeb] px-3 py-0.5 text-center text-[11px] font-medium text-[#8b1a1a] hover:scale-105"
                        >
                          {label}
                        </button>
                      </div>
                    );
                  })}

                {/* Subagents Branching Tree */}
                {st.tasks.length > 0 && (
                  <div className="w-full flex flex-col items-center mt-2.5">
                    <div className="h-2 w-px bg-[#d1d5db]" />
                    {/* Fork junction line */}
                    <div className="grid grid-cols-2 gap-2 w-full pt-1 border-t border-[#d1d5db]">
                      {st.tasks.map((task) => (
                        <div key={task.id} className="flex flex-col items-center">
                          <button
                            type="button"
                            className="rounded-full bg-[#ebf3fe] px-2.5 py-0.5 text-[10px] font-semibold text-[#1d4ed8] hover:scale-105"
                          >
                            Task
                          </button>
                          {task.items
                            .filter(
                              (i) =>
                                i.item.type !== "agent_message" ||
                                i.item.command ||
                                i.item.changes?.length
                            )
                            .map((item, itemIdx) => {
                              const label = getToolLabel(item.item, item.eventType).label;
                              return (
                                <div key={itemIdx} className="flex flex-col items-center">
                                  <div className="h-2 w-px bg-[#d1d5db]" />
                                  <span className="rounded-full bg-[#f9ebeb] px-2 py-0.5 text-[10px] font-medium text-[#8b1a1a]">
                                    {label}
                                  </span>
                                </div>
                              );
                            })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </aside>
    </section>
  );
}

function MetricCard({
  label,
  value,
  accent = "text-[#18181b]",
  subtext,
}: {
  label: string;
  value?: number;
  accent?: string;
  subtext?: string;
}) {
  return (
    <div className="rounded-md border border-[#e5e7eb] bg-white px-3 py-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-[#6b7280]">{label}</p>
        {subtext && <span className="font-mono text-[10px] text-[#8b1a1a]">{subtext}</span>}
      </div>
      <p className={`mt-0.5 font-mono text-base font-semibold ${accent}`}>
        {(value ?? 0).toLocaleString()}
      </p>
    </div>
  );
}
