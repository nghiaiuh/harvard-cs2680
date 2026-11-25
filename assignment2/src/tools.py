import os
import subprocess
from pathlib import Path

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file inside the working directory with line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the file"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit a file inside the working directory by replacing an exact string with a new string.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path to the file"
                    },
                    "old_string": {
                        "type": "string",
                        "description": "Exact text to find and replace"
                    },
                    "new_string": {
                        "type": "string",
                        "description": "New text to replace the old string"
                    }
                },
                "required": ["path", "old_string", "new_string"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a shell command inside the working directory and return stdout, stderr, and exit code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Shell command to execute"
                    }
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "done",
            "description": "Finish the current task and provide a summary of the completed work.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Summary of the completed task and its results"
                    }
                },
                "required": ["summary"]
            }
        }
    }
]

def _resolve_safe_path(workdir: str, rel_path: str) -> Path:
    """Ensure agent cannot access or modify files outside workdir."""
    base = Path(workdir).resolve()
    target = (base / rel_path).resolve()
    if not target.is_relative_to(base):
        raise PermissionError(f"Access denied: path '{rel_path}' is outside the working directory.")
    return target

def read_file(workdir: str, path: str) -> tuple[str, bool]:
    try:
        target = _resolve_safe_path(workdir, path)
        if not target.exists():
            return f"Error: File '{path}' does not exist.", True
        if not target.is_file():
            return f"Error: '{path}' is not a file.", True

        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
        numbered = [f"{i+1:4d} | {line}" for i, line in enumerate(lines)]
        return "\n".join(numbered), False
    except Exception as e:
        return f"Error reading file '{path}': {e}", True

def edit_file(workdir: str, path: str, old_string: str, new_string: str) -> tuple[str, bool]:
    try:
        target = _resolve_safe_path(workdir, path)
        if not target.exists():
            return f"Error: File '{path}' does not exist.", True

        content = target.read_text(encoding="utf-8", errors="replace")
        if old_string not in content:
            return f"Error: `old_string` was not found in '{path}'. Make sure exact indentation and text match.", True
        
        count = content.count(old_string)
        if count > 1:
            return f"Error: `old_string` appears {count} times in '{path}'. Please provide more surrounding lines to make it unique.", True
        new_content = content.replace(old_string, new_string, 1)
        target.write_text(new_content, encoding="utf-8")
        return f"Successfully updated '{path}'.", False
    except Exception as e:
        return f"Error editing file '{path}': {e}", True

def bash(workdir: str, command: str) -> tuple[str, bool]:
    try:
        # Inject workdir into PYTHONPATH to avoid ModuleNotFoundError across platforms
        env = os.environ.copy()
        abs_workdir = str(Path(workdir).resolve())
        existing_pp = env.get("PYTHONPATH", "")
        if existing_pp:
            env["PYTHONPATH"] = f"{abs_workdir}{os.pathsep}{existing_pp}"
        else:
            env["PYTHONPATH"] = abs_workdir

        proc = subprocess.run(
            command,
            shell=True,
            cwd=workdir,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = (proc.stdout + proc.stderr).strip()
        if not output:
            output = f"(Command executed with exit code {proc.returncode} and no output)"
        is_error = proc.returncode != 0
        return f"Exit code: {proc.returncode}\n{output}", is_error
    except subprocess.TimeoutExpired:
        return "Error: Command time out after 30 seconds.", True
    except Exception as e:
        return f"Error executing bash command: {e}", True

def done(summary: str) -> tuple[str, bool]:
    return f"Task completed: {summary}", False

def execute_tool(workdir: str, name: str, args: dict) -> tuple[str, bool]:
    """Dispatcher: maps tool names to corresponding execution functions."""
    if name == "read_file":
        return read_file(workdir, args.get("path", ""))
    elif name == "edit_file":
        return edit_file(workdir, args.get("path", ""), args.get("old_string", ""), args.get("new_string", ""))
    elif name == "bash":
        return bash(workdir, args.get("command", ""))
    elif name == "done":
        return done(args.get("summary", ""))
    else:
        return f"Error: Unknown tool '{name}'.", True
