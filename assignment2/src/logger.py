"""
TraceLogger: Implements structured JSONL trajectory logging for CS2680 Assignment 2.
Schema 0.3 specification:
  - run_start: model_id, workdir, problem
  - api_request: iteration, prompt_tokens, completion_tokens, total_tokens
  - tool_call: iteration, tool_name, arguments
  - tool_result: iteration, tool_name, output, is_error
  - run_end: reason, num_iterations, time_elapsed_seconds
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

class TraceLogger:
    def __init__(self, enabled: bool = False, log_dir: str = "madsLoop_logs", custom_filename: Optional[str] = None):
        self.enabled = enabled
        self.log_file: Optional[Path] = None

        if not self.enabled:
            return

        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # Allow custom filename via parameter or MADSLOOP_LOG_FILE environment variable
        if custom_filename:
            self.log_file = self.log_dir / custom_filename
        elif os.environ.get("MADSLOOP_LOG_FILE"):
            self.log_file = self.log_dir / os.environ["MADSLOOP_LOG_FILE"]
        else:
            # Auto-increment run number: run1.jsonl, run2.jsonl...
            i = 1
            while (self.log_dir / f"run{i}.jsonl").exists():
                i += 1
            self.log_file = self.log_dir / f"run{i}.jsonl"

        # Start each trace session with a clean file
        self.log_file.write_text("", encoding="utf-8")

    def _write_event(self, event_type: str, data: dict[str, Any]):
        if not self.enabled or not self.log_file:
            return

        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event_type,
            **data,
        }
        with self.log_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def log_run_start(self, model_id: str, workdir: str, problem: str):
        self._write_event("run_start", {
            "model_id": model_id,
            "workdir": str(workdir),
            "problem": problem,
        })

    def log_api_request(self, iteration: int, prompt_tokens: int, completion_tokens: int, total_tokens: int):
        self._write_event("api_request", {
            "iteration": iteration,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        })

    def log_tool_call(self, iteration: int, tool_name: str, arguments: dict):
        self._write_event("tool_call", {
            "iteration": iteration,
            "tool_name": tool_name,
            "arguments": arguments,
        })

    def log_tool_result(self, iteration: int, tool_name: str, output: str, is_error: bool):
        self._write_event("tool_result", {
            "iteration": iteration,
            "tool_name": tool_name,
            "output": output,
            "is_error": is_error,
        })

    def log_run_end(self, reason: str, num_iterations: int, time_elapsed_seconds: float):
        self._write_event("run_end", {
            "reason": reason,
            "num_iterations": num_iterations,
            "time_elapsed_seconds": round(time_elapsed_seconds, 2),
        })
