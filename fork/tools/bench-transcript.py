#!/usr/bin/env python3
"""Write a deterministic session file with N messages, for fork/tools/bench.sh (R1.3).

usage: bench-transcript.py <messages> <out.jsonl> <cwd>

Messages repeat a 4-message round: user prompt, assistant text with a bash tool
call, tool result (20 lines), assistant markdown answer with a code block. A
remainder adds user/assistant-text pairs, so no tool call is left unanswered.
"""

import json
import sys

n, out, cwd = int(sys.argv[1]), sys.argv[2], sys.argv[3]
base_ms = 1_760_000_000_000
usage = {
    "input": 1000,
    "output": 200,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 1200,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
}


def assistant(content, stop):
    return {
        "role": "assistant",
        "content": content,
        "api": "fake-scripted",
        "provider": "fake",
        "model": "scripted",
        "usage": usage,
        "stopReason": stop,
    }


def answer(i):
    return (
        f"## Step {i}\n\nThe function `handle{i}` now validates its input before use. "
        "Changes:\n\n- **parser**: rejects empty lines\n- **writer**: flushes once\n\n"
        f"```ts\nexport function handle{i}(input: string): number {{\n"
        "  const trimmed = input.trim();\n  if (trimmed.length === 0) return 0;\n"
        "  return trimmed.split(\"\\n\").length;\n}\n```\n\n"
        "| File | Lines |\n|---|---|\n| src/parser.ts | 42 |\n| src/writer.ts | 17 |\n"
    )


def messages():
    i = 0
    while True:
        call_id = f"call_{i}"
        yield {"role": "user", "content": f"Step {i}: check the parser and fix handle{i}."}
        yield assistant(
            [
                {"type": "text", "text": "Let me look at the files first."},
                {"type": "toolCall", "id": call_id, "name": "bash", "arguments": {"command": "ls -la src"}},
            ],
            "toolUse",
        )
        yield {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": "bash",
            "content": [
                {"type": "text", "text": "\n".join(f"-rw-r--r-- 1 user user {100 + k} file{k}.ts" for k in range(20))}
            ],
            "isError": False,
        }
        yield assistant([{"type": "text", "text": answer(i)}], "stop")
        i += 1


def pairs():
    i = 0
    while True:
        yield {"role": "user", "content": f"Follow-up {i}: anything else?"}
        yield assistant([{"type": "text", "text": answer(i)}], "stop")
        i += 1


rounds, rest = divmod(n, 4)
picked = []
gen = messages()
picked += [next(gen) for _ in range(rounds * 4)]
gen = pairs()
picked += [next(gen) for _ in range(rest - rest % 2)]
if rest % 2:
    picked.append({"role": "user", "content": "One more question."})

with open(out, "w", encoding="utf-8") as f:
    f.write(json.dumps({"type": "session", "version": 3, "id": f"bench-{n}", "timestamp": "2026-01-01T00:00:00.000Z", "cwd": cwd}) + "\n")
    parent = None
    for k, message in enumerate(picked):
        message["timestamp"] = base_ms + k * 1000
        entry_id = f"{k:08x}"
        entry = {"type": "message", "id": entry_id, "parentId": parent, "timestamp": "2026-01-01T00:00:00.000Z", "message": message}
        f.write(json.dumps(entry) + "\n")
        parent = entry_id
