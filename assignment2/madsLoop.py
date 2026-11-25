"""
madsLoop: A minimal coding-agent harness for CS2680 Assignment 2.
Usage:
    python madsLoop.py -p "<problem statement>" [--log] <workdir>
"""
import argparse
import os
import sys
import time
from pathlib import Path
from openai import OpenAI
from src.agentic_loop import run_agent
from src.logger import TraceLogger

def load_dotenv_simple():
    """Automatically read .env file if present to load API keys and config."""
    for candidate in [Path(".env"), Path(__file__).resolve().parent / ".env"]:
        if candidate.exists() and candidate.is_file():
            try:
                for line in candidate.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k, v = k.strip(), v.strip().strip("'\"")
                        if k and k not in os.environ:
                            os.environ[k] = v
            except Exception:
                pass
            break

def parse_args():
    parser = argparse.ArgumentParser(
        description="madsLoop: A minimal coding-agent harness"
    )
    parser.add_argument(
        "-p", "--problem",
        required=True,
        help="The problem statement or issue description"
    )
    parser.add_argument(
        "--log",
        action="store_true",
        default=False,
        help="Enable trace logging to madsLoop_logs/ directory (Schema 0.3)"
    )
    parser.add_argument(
        "workdir",
        help="Path to the repository checkout (working directory)"
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("MADSLOOP_MODEL", "gemini-3.1-flash-lite"),
        help="Model ID to use (default: gemini-3.1-flash-lite or env MADSLOOP_MODEL)"
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=20,
        help="Maximum loop iterations (default: 20)"
    )
    return parser.parse_args()

def init_client() -> OpenAI:
    load_dotenv_simple()
    api_key = (
        os.environ.get("GEMINI_API_KEY")
        or os.environ.get("CS2680_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    if not api_key:
        print(
            "Error: No API key found!\n"
            "Please set your Gemini API key in PowerShell:\n"
            '    $env:GEMINI_API_KEY = "your_gemini_api_key_here"\n'
            "Or create a .env file with:\n"
            "    GEMINI_API_KEY=your_gemini_api_key_here",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    # OpenAI-compatible base URL for Google Gemini
    base_url = os.environ.get(
        "OPENAI_BASE_URL",
        "https://generativelanguage.googleapis.com/v1beta/openai/"
    )
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=60.0)
    return client

def main():
    args = parse_args()

    # Validate working directory
    workdir_path = Path(args.workdir).resolve()
    if not workdir_path.exists() or not workdir_path.is_dir():
        print(
            f"Error: Working directory '{args.workdir}' does not exist or is not a directory.",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    client = init_client()

    # Initialize TraceLogger if --log flag is enabled
    logger = TraceLogger(enabled=args.log)

    print(f"==================================================", flush=True)
    print(f"[madsLoop] Starting coding agent harness", flush=True)
    print(f"[madsLoop] Model    : {args.model}", flush=True)
    print(f"[madsLoop] Workdir  : {workdir_path}", flush=True)
    if args.log:
        print(f"[madsLoop] Logging  : ENABLED -> {logger.log_file}", flush=True)
    else:
        print(f"[madsLoop] Logging  : DISABLED (pass --log to enable)", flush=True)
    problem_preview = args.problem[:80] + "..." if len(args.problem) > 80 else args.problem
    print(f"[madsLoop] Problem  : {problem_preview}", flush=True)
    print(f"==================================================", flush=True)

    start_time = time.time()

    # Log run start event
    if args.log:
        logger.log_run_start(
            model_id=args.model,
            workdir=str(workdir_path),
            problem=args.problem,
        )

    # Start agent loop
    reason, iterations = run_agent(
        client=client,
        model=args.model,
        problem=args.problem,
        workdir=str(workdir_path),
        max_iterations=args.max_iterations,
        logger=logger,
    )

    elapsed = time.time() - start_time

    # Log run end event
    if args.log:
        logger.log_run_end(
            reason=reason,
            num_iterations=iterations,
            time_elapsed_seconds=elapsed,
        )

    print(f"\n==================================================", flush=True)
    print(f"[madsLoop] Finished with reason : '{reason}'", flush=True)
    print(f"[madsLoop] Total iterations     : {iterations}", flush=True)
    print(f"[madsLoop] Time elapsed         : {elapsed:.2f}s", flush=True)
    if args.log:
        print(f"[madsLoop] Trace saved to       : {logger.log_file}", flush=True)
    print(f"==================================================", flush=True)

if __name__ == "__main__":
    main()
