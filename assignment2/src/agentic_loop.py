import json
import sys
import time
from typing import Optional
from src.prompts import build_system_prompt
from src.tools import TOOL_SCHEMAS, execute_tool
from src.logger import TraceLogger

def run_agent(
    client,
    model: str,
    problem: str,
    workdir: str,
    max_iterations: int = 15,
    logger: Optional[TraceLogger] = None,
):
    messages = [
        {"role": "system", "content": build_system_prompt(workdir)},
        {"role": "user", "content": problem},
    ]

    for iteration in range(1, max_iterations + 1):
        print(f"\n[Iteration {iteration}/{max_iterations}] Calling model: {model}...", flush=True)
        
        # Exponential backoff to handle rate limits (HTTP 429)
        resp = None
        for attempt in range(4):
            try:
                resp = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=TOOL_SCHEMAS,
                )
                break
            except Exception as e:
                err_str = str(e)
                if ("429" in err_str or "ResourceExhausted" in err_str) and attempt < 3:
                    wait_time = (attempt + 1) * 6
                    print(f"  [Rate Limit 429] Waiting {wait_time}s before retrying (attempt {attempt + 1}/3)...", flush=True)
                    time.sleep(wait_time)
                else:
                    print(f"[madsLoop Error] API request failed: {e}", file=sys.stderr, flush=True)
                    return f"api_error: {e}", iteration

        msg = resp.choices[0].message
        
        # Log api_request (token usage) if logger is enabled
        if logger:
            usage = getattr(resp, "usage", None)
            prompt_tokens = usage.prompt_tokens if usage else 0
            completion_tokens = usage.completion_tokens if usage else 0
            total_tokens = usage.total_tokens if usage else 0
            logger.log_api_request(
                iteration=iteration,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
            )

        # Append full assistant message (including thought signatures) to conversation history
        messages.append(msg)

        # Print model reasoning message if present
        if msg.content:
            print(f"[Model Message]:\n{msg.content.strip()}\n", flush=True)

        if not msg.tool_calls:
            print("[madsLoop] Model did not request any tool calls. Finished.", flush=True)
            return "no_tool_calls", iteration

        task_completed = False

        for i, tc in enumerate(msg.tool_calls):
            name = tc.function.name
            call_id = tc.id or f"call_{i}"
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError as e:
                err_msg = f"Error: Malformed JSON arguments: {e}"
                print(f"  [Tool: {name}] JSON Parse Error: {e}", flush=True)
                if logger:
                    logger.log_tool_call(iteration=iteration, tool_name=name, arguments={"raw": tc.function.arguments})
                    logger.log_tool_result(iteration=iteration, tool_name=name, output=err_msg, is_error=True)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": err_msg,
                })
                continue

            # Log tool_call event to trace file
            if logger:
                logger.log_tool_call(iteration=iteration, tool_name=name, arguments=args)

            # Print tool call details to stdout
            if name == "bash":
                print(f"  [Tool Call: bash] $ {args.get('command')}", flush=True)
            elif name == "read_file":
                print(f"  [Tool Call: read_file] path = '{args.get('path')}'", flush=True)
            elif name == "edit_file":
                print(f"  [Tool Call: edit_file] path = '{args.get('path')}'", flush=True)
            elif name == "done":
                print(f"  [Tool Call: done] summary = '{args.get('summary')}'", flush=True)
            else:
                print(f"  [Tool Call: {name}] args = {args}", flush=True)

            result, is_error = execute_tool(workdir, name, args)

            # Log tool_result event to trace file
            if logger:
                logger.log_tool_result(iteration=iteration, tool_name=name, output=result, is_error=is_error)

            # Print tool result preview
            lines = result.strip().splitlines()
            if len(lines) > 8:
                preview = "\n".join("    " + l for l in lines[:5]) + f"\n    ... [{len(lines) - 5} lines omitted]"
            else:
                preview = "\n".join("    " + l for l in lines)
            print(f"  [Tool Result]:\n{preview}", flush=True)

            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": result,
            })

            if name == "done":
                task_completed = True

        if task_completed:
            return "done", iteration

        # Short sleep between iterations to prevent burst rate limits
        time.sleep(1.0)

    return "max_iterations", max_iterations
