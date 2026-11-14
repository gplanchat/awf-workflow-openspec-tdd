#!/usr/bin/env python3
"""PreToolUse hook: blocks writes to the waiver registry of the openspec-tdd pack (awf/waivers.yaml, awf/waivers.log).

Only flow.sh writes these files, through the flow-waive workflow that /flow:waive runs on your request. A write tool
aimed at them is blocked; a Bash command that cites them passes only when it runs flow.sh or simply reads the file.
The registry lives in <git-common-dir>/awf/ (formerly .awf/). A block exits with code 2 and a message on stderr.
"""
import json
import re
import sys

REGISTRY = re.compile(r"(^|/)\.?awf/waivers\.(yaml|log)$")
CITES = re.compile(r"waivers\.(yaml|log)")
FLOW = re.compile(r"^\s*(bash\s+)?\S*flow\.sh\s+(waive|waived|fingerprint|context|migrate)\b[^;&|<>`$]*$")
READ = re.compile(r"^\s*(cat|grep|head|tail|wc|ls)\b[^;&|<>`$]*$")
FILE_KEYS = ("file_path", "path", "notebook_path")


def block(reason: str) -> None:
    print(
        f"Waivers: {reason} The registry is written only by /flow:waive, when you ask for a waiver yourself.",
        file=sys.stderr,
    )
    sys.exit(2)


def main() -> None:
    try:
        call = json.load(sys.stdin)
    except json.JSONDecodeError:
        return  # unreadable input: this guard decides nothing, the other hooks stay active
    tool_input = call.get("tool_input") or {}
    if call.get("tool_name") == "Bash":
        command = tool_input.get("command", "")
        if CITES.search(command) and not (FLOW.match(command) or READ.match(command)):
            block("this command cites the registry without going through flow.sh.")
        return
    for key in FILE_KEYS:
        if REGISTRY.search(str(tool_input.get(key, ""))):
            block("writing the registry directly is not allowed.")


main()
