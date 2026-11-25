"use client";

import { useRef, useState, useCallback } from "react";
import type {
  AgentEvent,
  AgentStatus,
  DiagnosticItem,
  SessionMetadata,
} from "@/types";

export type { AgentEvent } from "@/types";

export function useAgentStream() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [startedAt, setStartedAt] = useState<number>();
  const [endedAt, setEndedAt] = useState<number>();
  const [durationMs, setDurationMs] = useState<number>();
  const abortRef = useRef<AbortController | null>(null);

  const resetForSession = useCallback((metadata: SessionMetadata, sessionEvents: AgentEvent[]) => {
    setEvents(sessionEvents);
    setStatus(metadata.status);
    setError("");
    setWarnings([]);
    setDiagnostics([]);

    if (metadata.startedAt) {
      setStartedAt(new Date(metadata.startedAt).getTime());
    } else {
      setStartedAt(undefined);
    }

    if (metadata.endedAt) {
      setEndedAt(new Date(metadata.endedAt).getTime());
    } else {
      setEndedAt(undefined);
    }

    setDurationMs(metadata.durationMs);
  }, []);

  async function run(prompt: string, threadId?: string) {
    if (abortRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;

    setEvents([]);
    const startTimestamp = Date.now();
    setStartedAt(startTimestamp);
    setEndedAt(undefined);
    setDurationMs(undefined);
    setError("");
    setWarnings([]);
    setDiagnostics([]);
    setStatus("starting");

    try {
      const response = await fetch("/api/agent/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, threadId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errMessage = `HTTP ${response.status}`;
        try {
          const errData = await response.json();
          if (errData.error) errMessage = errData.error;
        } catch {
          // Keep HTTP status string
        }
        throw new Error(errMessage);
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      setStatus("running");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let receivedDone = false;

      function handleFrame(frame: string) {
        const lines = frame.split("\n");

        let eventName = "message";
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (!dataLines.length) return;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          setWarnings((prev) => [...prev, "Received malformed SSE data frame"]);
          return;
        }

        if (eventName === "agent") {
          setEvents((previous) => [...previous, data as unknown as AgentEvent]);
        } else if (eventName === "warning") {
          if (typeof data?.message === "string") {
            setWarnings((prev) => [...prev, data.message as string]);
          }
        } else if (eventName === "error") {
          setError(typeof data?.message === "string" ? data.message : "Agent error");
          setStatus("failed");
        } else if (eventName === "done") {
          receivedDone = true;
          const finalStatus: AgentStatus =
            data.status === "timed_out"
              ? "timed_out"
              : data.status === "cancelled"
              ? "cancelled"
              : data.success
              ? "completed"
              : "failed";

          setStatus(finalStatus);

          if (typeof data.startedAt === "number") setStartedAt(data.startedAt);
          if (typeof data.endedAt === "number") setEndedAt(data.endedAt);
          if (typeof data.durationMs === "number") setDurationMs(data.durationMs);
          if (Array.isArray(data.diagnostics)) {
            setDiagnostics(data.diagnostics as DiagnosticItem[]);
          }
        }
      }

      while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          handleFrame(frame);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        handleFrame(buffer);
      }

      if (!receivedDone && !controller.signal.aborted) {
        throw new Error("Stream closed prematurely without done event");
      }
    } catch (err) {
      const finishTimestamp = Date.now();
      setEndedAt(finishTimestamp);
      setDurationMs(finishTimestamp - startTimestamp);

      if (controller.signal.aborted) {
        setStatus("cancelled");
        setDiagnostics((prev) => [
          ...prev,
          {
            category: "cancellation",
            severity: "info",
            message: "Execution cancelled by client request",
          },
        ]);
      } else {
        const errMsg = err instanceof Error ? err.message : "Stream error";
        setError(errMsg);
        setStatus("failed");
        setDiagnostics((prev) => [
          ...prev,
          {
            category: errMsg.includes("Stream closed prematurely")
              ? "sse_interrupted"
              : "spawn_error",
            severity: "error",
            message: errMsg,
          },
        ]);
      }
    } finally {
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  return {
    events,
    status,
    error,
    warnings,
    diagnostics,
    run,
    cancel,
    startedAt,
    endedAt,
    durationMs,
    resetForSession,
  };
}
