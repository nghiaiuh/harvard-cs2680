# Harvard CS2680 — Modern AI Systems

Coursework and implementation repository for **Harvard CS2680 (Modern AI Systems)** ([Course Assignments](https://cs2680.seas.harvard.edu/assignments/)).

## Course Overview

CS2680 explores the end-to-end systems engineering behind modern AI agents—progressing from observing how agents behave, to building reliable agent runtimes, optimizing token/latency efficiency, owning the LLM serving engine, and co-designing the full stack.

---

## Assignments

| # | Assignment | Focus | Status |
| :-: | :--- | :--- | :---: |
| **1** | **Mads-Lens: Watch the agent work** | Build a web dashboard to run real agent sessions, stream live tool-call trajectories, visualize subagent trees, inspect failures, resume sessions, and track run costs. | Completed ([`assignment1/`](./assignment1/)) |
| **2** | **Mads-Loop: Build the loop** | Build an autonomous coding agent harness around a model API (structured tool schemas, context management, retries, termination, graceful error handling) and evaluate it against benchmarks and custom tasks. | Completed ([`assignment2/`](./assignment2/)) |
| **3** | **Mads-Opt: Make every token count** | Optimize cost and latency around a black-box API by pruning/compressing context, routing to smaller models, overlapping tool execution, and redesigning control flow without sacrificing accuracy. | Planned |
| **4** | **Mads-Serve: Own the serving engine** | Replace frontier APIs by self-hosting an open model on a single GPU (RTX PRO 4500 32 GB), diagnosing runtime bottlenecks, and accelerating serving/agent execution with the model fixed. | Planned |
| **5** | **Mads-Stack: Optimize the full stack** | Co-optimize the agent, model selection, and serving engine end-to-end on Terminal-Bench 2.0, culminating in a full-stack synthesis of lessons learned across Assignments 2–5. | Planned |

---

## Key Knowledge & Skills Gained

* **Agent Observability & Diagnostics:** Designing real-time streaming UIs, structured JSONL trace schemas, failure taxonomy, and accurate token/cost accounting (including cached vs. non-cached tokens).
* **Agent Harness & Runtime Engineering:** Implementing resilient ReAct tool-calling loops, workspace sandboxing, rate-limit backoff, deterministic termination, and automated SWE-bench-style evaluation (`git diff` patch extraction + independent test referees).
* **Cost & Latency Optimization:** Understanding quadratic prompt-token growth over multi-turn trajectories, context compression, model routing, and parallel/overlapped tool execution.
* **LLM Serving & Full-Stack Co-Design:** Moving from black-box APIs to self-hosted inference engines, identifying throughput/latency bottlenecks under hardware constraints, and tuning the agent–model–server stack holistically.
