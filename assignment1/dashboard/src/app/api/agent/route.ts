
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentEvent } from "@/types";

const SANDBOX_DIR = path.resolve(
  process.cwd(),
  "../sandbox"
);

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

// Runs Codex in the sandbox and collects JSONL events from stdout.
function executeCodex(prompt: string): Promise<{
  events: AgentEvent[];
  exitCode: number | null;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    // Fixed command: user prompt is never interpolated
    // into the shell command.
    const command = [
      "codex",
      "-c mcp_servers.daydream.enabled=false",
      "-c mcp_servers.nogic.enabled=false",
      "-c mcp_servers.rendley.enabled=false",
      "exec",
      "--json",
      "--sandbox read-only",
      "--skip-git-repo-check",
      "-",
    ].join(" ");

    const child = spawn(
      "cmd.exe",
      ["/d", "/s", "/c", command],
      {
        cwd: SANDBOX_DIR,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }
    );

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let tooLarge = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;

      if (outputBytes > MAX_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill();
        return;
      }

      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 4096);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error("Codex execution timed out"));
        return;
      }

      if (tooLarge) {
        reject(new Error("Codex output exceeded limit"));
        return;
      }

      const events: AgentEvent[] = [];

      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;

        try {
          events.push(JSON.parse(line));
        } catch {
          // Ignore malformed output lines for now.
        }
      }

      resolve({ events, exitCode, stderr });
    });

    child.stdin.on("error", () => {
      // Child may exit before consuming stdin.
    });

    child.stdin.end(prompt);
  });
}

// Validates a prompt, runs Codex, and returns the completed run as JSON.
export async function POST(request: NextRequest) {
  // Local development only. Do not expose this endpoint
  // publicly without authentication and authorization.
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { error: "Local development only" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const prompt = body?.prompt;

    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      prompt.length > 4000
    ) {
      return NextResponse.json(
        { error: "Invalid prompt (1-4000 characters)" },
        { status: 400 }
      );
    }

    const result = await executeCodex(prompt);

    const completed = result.events.find(
      (event) => event.type === "turn.completed"
    );

    return NextResponse.json({
      success: result.exitCode === 0 && Boolean(completed),
      ...result,
    });
  } catch (error) {
    console.error("Agent execution failed:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown execution error",
      },
      { status: 500 }
    );
  }
}
