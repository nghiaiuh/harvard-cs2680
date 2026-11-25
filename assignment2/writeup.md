# CS2680 Assignment 2: Autonomous Coding Agent Harness & Benchmark Evaluation
**Course**: Harvard CS2680 - Modern AI Systems
**Author**: Phan Ho Son Nghia
**Date**: 25/11/2026
**Repository / Harness**: `madsLoop` (Model: `gemini-3.1-flash-lite`)

---

## 1. Executive Summary & System Architecture

In this assignment, we designed, implemented, and benchmarked `madsLoop`, a lightweight yet robust autonomous software engineering agent harness inspired by SWE-agent and standard ReAct loops. The system integrates:
1. **Core Harness (`madsLoop.py`, `src/agentic_loop.py`):** An iterative reasoning-action loop with structured tool calling (`bash`, `read_file`, `edit_file`, `done`), context history preservation, and an Exponential Backoff mechanism to mitigate API rate limits (HTTP 429).
2. **Standardized Telemetry (`src/logger.py`):** Fully compliant with **Trace Schema 0.3**, capturing granular timestamps, token usage metrics, tool invocation payloads, and execution exit states into reproducible `.jsonl` logs.
3. **Automated SWE-bench Evaluation (`evaluate_bench.py`):** An automated harness implementing repo clean/reset protocols, zero-human-intervention agent runs, minimal patch extraction (`git diff`), and an independent pytest referee.

Across our benchmark suite, the optimized harness achieved a **100.0% Pass@1 resolution rate** with minimal patch footprint.

---

## 2. Quantitative Benchmark Results

The benchmark was executed against two contrasting software engineering instances:
* `task_01_calculator`: Single-file bug isolation and edge-case handling (`ZeroDivisionError`, empty list averaging).
* `task_02_token_auth`: Multi-file token verification system involving Base64 unpadded string decoding (`auth/token.py`) and expiration claim logic (`auth/validator.py`).

### Benchmark Evaluation Scorecard

| Instance ID | Status | Iterations | Prompt Tokens | Completion Tokens | Total Tokens | Wall Time (s) | Patch Size |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `task_01_calculator` | **RESOLVED** | 6 | 23,781 | 309 | 24,090 | 27.5s | 16 lines |
| `task_02_token_auth` | **RESOLVED** | 9 | 72,519 | 457 | 72,976 | 39.5s | 28 lines |
| **Overall Performance** | **100.0% Pass@1** | **Avg: 7.5** | **96,300** | **766** | **97,066** | **67.0s** | **44 lines** |

### Key Quantitative Takeaways
1. **Token Asymmetry:** Prompt tokens dominate over 99.2% of total token consumption (96,300 vs. 766 tokens). Because full conversation context and tool outputs (e.g., directory trees, test outputs) accumulate quadratically over iterations, keeping trajectories short is paramount for cost efficiency.
2. **Patch Conciseness:** The agent produced minimal, surgically precise patches (16 lines and 28 lines, respectively) with zero hallucinated edits or stylistic pollution, passing all independent referee tests on the first attempt.
3. **Evaluation Scope (Threats to Validity):** While a 100.0% Pass@1 rate validates the correctness of our harness loop and referee pipeline, our suite currently comprises two small, self-contained synthetic tasks; it does not reflect the repository scale or ambiguity of full SWE-bench instances.

---

## 3. Case Study & Failure Mode Analysis: Environment Friction vs. Agent Intelligence

A critical discovery during this assignment was the profound impact of **Harness Environment Friction** on agent performance, illustrated by comparing our initial baseline run with the final optimized run on `task_02_token_auth`.

```text
[Baseline Run]   Iterations 3-14: Trapped in Windows PYTHONPATH syntax loop -> Exhausted 15 Iterations -> FAILED (Pass@1: 50%)
[Optimized Run]  Iterations 3-9:  Immediate diagnosis -> Precise multi-file edit -> All Tests Passed -> RESOLVED (Pass@1: 100%)
```

* **Root Cause (Baseline Failure):** In the unoptimized baseline, running `pytest tests/test_auth.py` on Windows raised `ModuleNotFoundError: No module named 'auth'` because Windows shells do not automatically include `.` in `sys.path`. The LLM repeatedly hallucinated Unix inline syntax (`PYTHONPATH=. pytest`), which `cmd.exe` rejected, burning iterations 3–14 until hitting `max_iterations = 15` with a 0-line patch.
* **Harness Fix & Result:** Instead of relying on the model to debug OS-specific shell quirks, we updated `src/tools.py::bash()` and `evaluate_bench.py::run_tests()` to automatically inject the absolute repository root into `PYTHONPATH`. Freed from environment friction, the agent diagnosed both bugs at Iteration 3, patched Base64 padding (`payload_str += "=" * (4 - missing_padding)`) and the expiration check (`current_time >= payload["exp"]`), and resolved the task cleanly in **9 iterations**.

---

## 4. Limits: Fundamentally Unsolvable Tasks for ReAct-based Agent Harnesses

While `madsLoop` successfully solved unit-testable bugs, real-world SWE benchmarks (like full SWE-bench) expose structural boundaries where this naive ReAct architecture fundamentally breaks down:

1. **Lack of an Objective Ground-Truth Oracle**  
   Our harness relies on a fast feedback loop: `run test -> read error -> edit code -> rerun test`. When a task lacks automated tests, or when the bug requires writing new integration tests from vague natural language issue descriptions, the agent frequently falls into **confirmation bias**—modifying production code to fit its own hallucinated assumptions and calling `done` prematurely.
2. **Side-Effect Polluting & Stateful Systems**  
   Our current harness runs directly on the host system without containerization (Docker). In tasks requiring database migrations, daemon background processes, port bindings, or system package updates, commands executed by `bash` have non-idempotent side effects. If an iteration fails midway, the workspace is left in a dirty state that `git checkout .` cannot fully revert.
3. **Flaky & Non-Deterministic Tests**  
   Bugs involving concurrency, race conditions, network latency, or distributed state often exhibit non-deterministic test results. A ReAct agent typically assumes a single passing test run implies resolution; a flaky test passing once by coincidence will cause the agent to terminate with an incomplete or invalid patch.
4. **Long-Horizon Needle-in-a-Haystack Search (Repo-Scale Blindness)**  
   For repositories with hundreds of thousands of lines of code, accumulating `dir` or `grep` outputs into the conversation context quickly exhausts context windows and degrades attention. Without higher-level semantic code retrieval (such as ctags, AST symbol graphs, or BM25/vector search), naive file navigation burns all iteration budgets before reaching the relevant source file.

---

## 5. Conclusion

Building `madsLoop` demonstrated that developing an autonomous coding agent is an end-to-end systems engineering problem. High benchmark accuracy is not achieved through LLM prompting alone, but through disciplined tool abstractions, proactive environment conditioning (e.g., path resolution), resilient telemetry, and rigorous sandboxing.
