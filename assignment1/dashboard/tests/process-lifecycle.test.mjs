import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function checkProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function terminateProcessTree(pid) {
  if (!pid) return Promise.resolve({ verified: true });

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let killerErr = "";
      killer.stderr.on("data", (chunk) => {
        killerErr += chunk.toString("utf8");
      });

      killer.on("close", (code) => {
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
        }, 200);
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

test("lifecycle state determination logic", () => {
  function determineRunStatus({ exitCode, sawTurnCompleted, sawTurnFailed, timedOut, cancelled, storageFailed }) {
    if (cancelled) return "cancelled";
    if (timedOut) return "timed_out";
    const success =
      exitCode === 0 &&
      !timedOut &&
      !cancelled &&
      !sawTurnFailed &&
      sawTurnCompleted &&
      !storageFailed;

    return success ? "completed" : "failed";
  }

  // Exit code 0 without turn.completed must NOT be marked completed
  assert.equal(
    determineRunStatus({
      exitCode: 0,
      sawTurnCompleted: false,
      sawTurnFailed: false,
      timedOut: false,
      cancelled: false,
      storageFailed: false,
    }),
    "failed"
  );

  // Normal successful completion
  assert.equal(
    determineRunStatus({
      exitCode: 0,
      sawTurnCompleted: true,
      sawTurnFailed: false,
      timedOut: false,
      cancelled: false,
      storageFailed: false,
    }),
    "completed"
  );

  // Non-zero exit code
  assert.equal(
    determineRunStatus({
      exitCode: 1,
      sawTurnCompleted: true,
      sawTurnFailed: false,
      timedOut: false,
      cancelled: false,
      storageFailed: false,
    }),
    "failed"
  );

  // Cancellation overrides
  assert.equal(
    determineRunStatus({
      exitCode: 0,
      sawTurnCompleted: true,
      sawTurnFailed: false,
      timedOut: false,
      cancelled: true,
      storageFailed: false,
    }),
    "cancelled"
  );

  // Timeout overrides
  assert.equal(
    determineRunStatus({
      exitCode: 0,
      sawTurnCompleted: false,
      sawTurnFailed: false,
      timedOut: true,
      cancelled: false,
      storageFailed: false,
    }),
    "timed_out"
  );
});

test("reliably stops real child process tree and verifies termination on Windows", async () => {
  // Spawn a real long-running nested tree: cmd.exe -> powershell Start-Sleep
  const child = spawn("cmd.exe", ["/c", "powershell -NoProfile -Command Start-Sleep -Seconds 30"], {
    windowsHide: true,
    stdio: "ignore",
  });

  assert.ok(child.pid, "Child process should have a valid PID");
  const pid = child.pid;

  // Verify it is alive
  assert.equal(checkProcessAlive(pid), true, "Child process should be alive after spawn");

  // Terminate process tree
  const result = await terminateProcessTree(pid);
  assert.equal(result.verified, true, `Process tree termination should be verified: ${result.message}`);

  // Confirm PID is no longer alive
  assert.equal(checkProcessAlive(pid), false, "Process should no longer be active");
});
