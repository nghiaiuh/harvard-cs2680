import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  startSession,
  saveEvent,
  finishSession,
  acquireSessionLock,
  validateThreadId,
} from "@/lib/session-store";
import { extractDiagnostics } from "@/lib/trajectory";
import type { AgentEvent, AgentStatus } from "@/types";

const SANDBOX_DIR = path.resolve(process.cwd(), "../sandbox");
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

function checkProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Safely and reliably terminates a process tree.
 * On Windows, invokes taskkill /pid <pid> /t /f and explicitly verifies termination.
 */
async function terminateProcessTree(pid: number): Promise<{ verified: boolean; message?: string }> {
  if (!pid) return { verified: true };

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let killerErr = "";
      killer.stderr.on("data", (chunk: Buffer) => {
        killerErr += chunk.toString("utf8");
      });

      killer.on("close", (code) => {
        // Exit code 0: process terminated.
        // Exit code 128: process was already dead.
        setTimeout(() => {
          const stillAlive = checkProcessAlive(pid);
          if (stillAlive) {
            resolve({
              verified: false,
              message: `taskkill exited with code ${code}, but PID ${pid} is still detected as active: ${killerErr.trim()}`,
            });
          } else {
            resolve({ verified: true });
          }
        }, 150);
      });

      killer.on("error", (err) => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
        resolve({
          verified: !checkProcessAlive(pid),
          message: `Failed to spawn taskkill: ${err.message}`,
        });
      });
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
    return Promise.resolve({ verified: !checkProcessAlive(pid) });
  }
}

// Validates a prompt and streams Codex events back as Server-Sent Events.
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return Response.json(
      { error: "Local development only" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt =
    typeof body === "object" && body !== null && "prompt" in body
      ? body.prompt
      : undefined;

  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
    return Response.json({ error: "Invalid prompt" }, { status: 400 });
  }

  const threadId =
    typeof body === "object" && body !== null && "threadId" in body
      ? body.threadId
      : undefined;

  if (threadId !== undefined) {
    if (typeof threadId !== "string") {
      return Response.json({ error: "Invalid thread ID" }, { status: 400 });
    }
    try {
      validateThreadId(threadId);
    } catch {
      return Response.json({ error: "Invalid thread ID format" }, { status: 400 });
    }
  }

  // Cross-process file-based lock acquisition
  let releaseLock: (() => Promise<void>) | null = null;
  if (threadId) {
    try {
      releaseLock = await acquireSessionLock(threadId);
    } catch (err: unknown) {
      return Response.json(
        { error: (err as Error).message || "Session is already running" },
        { status: 409 }
      );
    }
  }

  const encoder = new TextEncoder();
  const runStartedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let stdoutBuffer = "";
      let outputBytes = 0;
      let timedOut = false;
      let exceededLimit = false;
      let activeThreadId: string | undefined = threadId;
      let writeQueue = Promise.resolve();
      let storageFailed = false;
      let sawTurnCompleted = false;
      let sawTurnFailed = false;
      let cancelled = false;
      let spawnError: string | null = null;
      const collectedEvents: AgentEvent[] = [];

      // Writes one event to the SSE response.
      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // The stream may already be cancelled or disconnected.
        }
      }

      // Closes the stream safely, including after cancellation.
      async function finish() {
        if (closed) return;
        closed = true;

        if (releaseLock) {
          try {
            await releaseLock();
          } catch {
            // ignore
          }
          releaseLock = null;
        }

        try {
          controller.close();
        } catch {
          // Stream may have already been cancelled.
        }
      }

      const config = [
        "-c mcp_servers.daydream.enabled=false",
        "-c mcp_servers.nogic.enabled=false",
        "-c mcp_servers.rendley.enabled=false",
      ].join(" ");

      const command = threadId
        ? [
            "codex",
            config,
            "exec resume",
            "--skip-git-repo-check",
            "--json",
            threadId,
            "-",
          ].join(" ")
        : [
            "codex",
            config,
            "exec",
            "--json",
            "--sandbox read-only",
            "--skip-git-repo-check",
            "-",
          ].join(" ");

      const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
        cwd: SANDBOX_DIR,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      async function stopProcessTree() {
        if (!child.pid) return;
        const res = await terminateProcessTree(child.pid);
        if (!res.verified) {
          send("warning", {
            message: res.message ?? "Process termination could not be verified",
          });
        }
      }

      const abort = async () => {
        cancelled = true;
        await stopProcessTree();
      };

      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) {
        abort();
      }

      // Parses one JSONL line and forwards it to the client.
      function processLine(line: string) {
        if (!line.trim()) return;

        try {
          const event: AgentEvent = JSON.parse(line);
          collectedEvents.push(event);

          if (
            event.type === "thread.started" &&
            typeof event.thread_id === "string"
          ) {
            activeThreadId = event.thread_id;
            // Acquire lock for newly created thread
            if (!threadId && activeThreadId && !releaseLock) {
              acquireSessionLock(activeThreadId)
                .then((rel) => {
                  releaseLock = rel;
                })
                .catch((e) => {
                  console.warn("Could not acquire lock for new thread:", e);
                });
            }
          }

          if (event.type === "turn.completed") {
            sawTurnCompleted = true;
          }

          if (event.type === "turn.failed") {
            sawTurnFailed = true;
          }

          send("agent", event);

          if (activeThreadId) {
            const id = activeThreadId;
            writeQueue = writeQueue
              .then(async () => {
                if (event.type === "thread.started") {
                  await startSession(id, prompt as string);
                }
                await saveEvent(id, event);
              })
              .catch((error) => {
                storageFailed = true;
                console.error("Session persistence failed:", error);
              });
          }
        } catch {
          send("warning", {
            message: "Invalid JSONL event detected and skipped",
          });
        }
      }

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;

        if (outputBytes > MAX_OUTPUT_BYTES) {
          exceededLimit = true;
          stopProcessTree();
          return;
        }

        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          processLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        send("stderr", {
          message: chunk.toString("utf8"),
        });
      });

      child.on("error", async (error) => {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);
        spawnError = error.message;

        send("error", {
          message: `Process spawn error: ${error.message}`,
        });

        const runEndedAt = Date.now();
        send("done", {
          exitCode: null,
          success: false,
          status: "failed",
          threadId: activeThreadId,
          startedAt: runStartedAt,
          endedAt: runEndedAt,
          durationMs: runEndedAt - runStartedAt,
        });

        await finish();
      });

      child.on("close", async (exitCode) => {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", abort);

        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
        }

        await writeQueue;

        const runEndedAt = Date.now();
        const durationMs = runEndedAt - runStartedAt;

        // Exit code 0 is NOT sufficient: turn.completed must be seen without turn.failed
        const success =
          exitCode === 0 &&
          !timedOut &&
          !cancelled &&
          !exceededLimit &&
          !sawTurnFailed &&
          sawTurnCompleted &&
          !storageFailed &&
          !spawnError;

        let finalStatus: AgentStatus;
        if (cancelled) {
          finalStatus = "cancelled";
        } else if (timedOut) {
          finalStatus = "timed_out";
        } else if (success) {
          finalStatus = "completed";
        } else {
          finalStatus = "failed";
        }

        if (activeThreadId) {
          try {
            await finishSession(
              activeThreadId,
              success,
              cancelled ? "cancelled" : timedOut ? "timed_out" : undefined,
              { startedAt: runStartedAt, endedAt: runEndedAt }
            );
          } catch (error) {
            console.error("Failed to finalize session:", error);
            storageFailed = true;
          }
        }

        if (timedOut) {
          send("error", { message: "Execution timed out (120s limit exceeded)" });
        } else if (exceededLimit) {
          send("error", { message: "Output byte limit (5MB) exceeded" });
        } else if (storageFailed) {
          send("error", { message: "Session storage failed" });
        } else if (exitCode !== 0 && !cancelled) {
          send("error", { message: `Process exited with non-zero exit code ${exitCode}` });
        } else if (!sawTurnCompleted && !cancelled && exitCode === 0) {
          send("error", { message: "Process ended without completing the agent turn" });
        }

        const diagnostics = extractDiagnostics(collectedEvents, {
          exitCode,
          error: spawnError ?? undefined,
          cancelled,
          timedOut,
          storageFailed,
        });

        send("done", {
          exitCode,
          success: success && !storageFailed,
          status: finalStatus,
          threadId: activeThreadId,
          startedAt: runStartedAt,
          endedAt: runEndedAt,
          durationMs,
          diagnostics,
        });

        await finish();
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        stopProcessTree();
      }, TIMEOUT_MS);

      child.stdin.on("error", () => {
        // Child may exit before reading stdin
      });

      child.stdin.end(prompt);
      send("status", { message: "Agent started" });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
