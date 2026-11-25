"""
evaluate_bench.py: Automated Benchmark Evaluator for CS2680 Assignment 2.
Implements the SWE-bench evaluation protocol:
  1. Reset task repository to clean state.
  2. Execute madsLoop with problem statement and trace logging.
  3. Extract git diff patch (git diff > patches/<instance_id>.patch).
  4. Run independent verification tests.
  5. Parse telemetry from madsLoop_logs/ and output executive scorecard.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Ensure root directory is in sys.path
ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

def reset_repo(workdir: Path):
    """Reset repository to a clean initial git state."""
    subprocess.run(["git", "checkout", "--", "."], cwd=workdir, capture_output=True)
    subprocess.run(["git", "clean", "-fd", "--", "."], cwd=workdir, capture_output=True)

def extract_patch(workdir: Path, patch_path: Path) -> str:
    """Extract git diff to a clean patch file."""
    res = subprocess.run(["git", "diff", "--relative", "--", "."], cwd=workdir, capture_output=True, text=True)
    patch_content = res.stdout
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    patch_path.write_text(patch_content, encoding="utf-8")
    return patch_content

def run_tests(workdir: Path, test_command: str) -> tuple[bool, str]:
    """Independent verification referee to evaluate task resolution."""
    env = os.environ.copy()
    current_pp = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = f"{str(workdir)}{os.pathsep}{current_pp}" if current_pp else str(workdir)
    proc = subprocess.run(
        test_command,
        shell=True,
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    is_passed = (proc.returncode == 0)
    output = (proc.stdout + proc.stderr).strip()
    return is_passed, output

def parse_trace_log(log_path: Path) -> dict:
    """Parse .jsonl trace file to extract telemetry metrics."""
    metrics = {
        "iterations": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "time_elapsed": 0.0,
        "reason": "unknown",
        "tool_counts": {},
    }
    if not log_path.exists():
        return metrics

    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
            ev_type = event.get("event")
            if ev_type == "run_start":
                metrics = {
                    "iterations": 0,
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                    "time_elapsed": 0.0,
                    "reason": "unknown",
                    "tool_counts": {},
                }
            elif ev_type == "api_request":
                metrics["prompt_tokens"] += event.get("prompt_tokens", 0)
                metrics["completion_tokens"] += event.get("completion_tokens", 0)
                metrics["total_tokens"] += event.get("total_tokens", 0)
            elif ev_type == "tool_call":
                tname = event.get("tool_name", "unknown")
                metrics["tool_counts"][tname] = metrics["tool_counts"].get(tname, 0) + 1
            elif ev_type == "run_end":
                metrics["reason"] = event.get("reason", "unknown")
                metrics["iterations"] = event.get("num_iterations", 0)
                metrics["time_elapsed"] = event.get("time_elapsed_seconds", 0.0)
        except Exception:
            pass

    return metrics

def run_benchmark(tasks_path: Path, model: str = None):
    if not tasks_path.exists():
        print(f"[Error] Tasks file not found: {tasks_path}", file=sys.stderr)
        sys.exit(1)

    tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
    print("=" * 100)
    print(f"CS2680 BENCHMARK EVALUATOR - SWE-bench Protocol")
    print(f"Tasks Catalog : {tasks_path} ({len(tasks)} tasks)")
    print(f"Python Exec   : {sys.executable}")
    print("=" * 100)

    results = []
    patches_dir = ROOT_DIR / "patches"
    patches_dir.mkdir(exist_ok=True)

    for idx, task in enumerate(tasks, 1):
        instance_id = task.get("instance_id", f"task_{idx}")
        workdir = (ROOT_DIR / task.get("workdir", ".")).resolve()
        problem = task.get("problem_statement", "")
        test_cmd = task.get("test_command", "pytest")

        print(f"\n[{idx}/{len(tasks)}] Evaluating: {instance_id}")
        print(f"  -> Workdir : {workdir}")
        print(f"  -> Problem : {problem[:70]}...")

        # 1. Reset repository to initial buggy state
        reset_repo(workdir)

        # 2. Configure dedicated log file for each task
        task_log_file = f"{instance_id}.jsonl"
        log_full_path = ROOT_DIR / "madsLoop_logs" / task_log_file
        if log_full_path.exists():
            log_full_path.unlink()
        env = os.environ.copy()
        env["MADSLOOP_LOG_FILE"] = task_log_file

        # 3. Launch madsLoop agent harness
        cmd = [
            sys.executable,
            str(ROOT_DIR / "madsLoop.py"),
            "-p", problem,
            "--log",
            str(workdir),
        ]
        if model:
            cmd.extend(["--model", model])

        start_time = time.time()
        agent_proc = subprocess.run(cmd, env=env, text=True)
        wall_time = time.time() - start_time

        # 4. Extract git diff patch
        patch_path = patches_dir / f"{instance_id}.patch"
        patch_text = extract_patch(workdir, patch_path)
        patch_lines = len(patch_text.splitlines()) if patch_text else 0

        # 5. Independent referee verification test
        is_resolved, test_output = run_tests(workdir, test_cmd)
        status_label = "RESOLVED" if is_resolved else "FAILED"

        # 6. Parse metrics from trace log
        log_full_path = ROOT_DIR / "madsLoop_logs" / task_log_file
        metrics = parse_trace_log(log_full_path)

        result_entry = {
            "instance_id": instance_id,
            "status": status_label,
            "iterations": metrics["iterations"],
            "prompt_tokens": metrics["prompt_tokens"],
            "completion_tokens": metrics["completion_tokens"],
            "total_tokens": metrics["total_tokens"],
            "time_elapsed_s": metrics["time_elapsed"] or round(wall_time, 2),
            "patch_lines": patch_lines,
            "patch_file": str(patch_path.relative_to(ROOT_DIR)),
            "tool_counts": metrics["tool_counts"],
        }
        results.append(result_entry)
        print(f"  -> Result  : {status_label} (Patch: {patch_lines} lines | Time: {result_entry['time_elapsed_s']}s)")

    # 7. Print Leaderboard Scorecard
    print("\n" + "=" * 105)
    print("                              BENCHMARK EVALUATION SCORECARD")
    print("=" * 105)
    header = f"{'Instance ID':<25} | {'Status':<10} | {'Iter':<5} | {'Tokens (In / Out)':<22} | {'Time (s)':<9} | {'Patch File'}"
    print(header)
    print("-" * 105)

    resolved_count = 0
    total_tokens_all = 0
    total_time_all = 0.0

    for r in results:
        if r["status"] == "RESOLVED":
            resolved_count += 1
        total_tokens_all += r["total_tokens"]
        total_time_all += r["time_elapsed_s"]

        tokens_str = f"{r['prompt_tokens']:,} / {r['completion_tokens']:,}"
        row = (
            f"{r['instance_id']:<25} | "
            f"{r['status']:<10} | "
            f"{r['iterations']:<5} | "
            f"{tokens_str:<22} | "
            f"{r['time_elapsed_s']:<9.1f} | "
            f"{r['patch_file']}"
        )
        print(row)

    print("-" * 105)
    pass_rate = (resolved_count / len(results)) * 100 if results else 0
    print(f"Overall Pass@1 Rate : {pass_rate:.1f}% ({resolved_count}/{len(results)} tasks resolved)")
    print(f"Total Tokens Used   : {total_tokens_all:,}")
    print(f"Total Time Elapsed  : {total_time_all:.2f}s")
    print("=" * 105)

    # Save summary results to benchmarks/eval_results.json
    results_path = ROOT_DIR / "benchmarks" / "eval_results.json"
    results_path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n[Summary] Evaluation results saved to: {results_path.relative_to(ROOT_DIR)}")

def main():
    parser = argparse.ArgumentParser(description="Automated Benchmark Evaluator for CS2680")
    parser.add_argument(
        "--tasks",
        default=None,
        help="Path to tasks.json catalog (default: benchmarks/task.json or benchmarks/tasks.json)"
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Override model ID (e.g. gemini-3.1-flash-lite)"
    )
    args = parser.parse_args()

    # Auto-discover task catalog file
    if args.tasks:
        tasks_file = Path(args.tasks).resolve()
    else:
        candidate_1 = ROOT_DIR / "benchmarks" / "task.json"
        candidate_2 = ROOT_DIR / "benchmarks" / "tasks.json"
        tasks_file = candidate_1 if candidate_1.exists() else candidate_2

    run_benchmark(tasks_file, model=args.model)

if __name__ == "__main__":
    main()
