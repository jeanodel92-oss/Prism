#!/usr/bin/env python3
"""Break down the prompt pi sends into parts and count them (roadmap R5.1).

usage: prompt-cost.py [--tokenize-url URL] <name>=<dump.json> ... > report.json
       prompt-cost.py --summary <report.json>

With scenarios "modules-on" and "off:<module>" (prompt-cost.sh --modules), the
summary also lists, per module, the parts that disappear or shrink when it is off.

Input: dumps written by fork/tools/prompt-probe.ts. Parts:
  section:<name>        a system prompt section as sent (tags included);
  context:<path>        one context file inside section:project_context;
  skill:<name>          one entry inside section:skills;
  tool:<name>           one tool definition, as JSON {name, description, parameters}.
context:* and skill:* are details of their section and are not added twice to the total.

Counts per part:
  chars       UTF-16 code units, as JavaScript counts them;
  estimate    ceil(chars / 4), pi's own heuristic (estimateTokens in
              compaction.ts). Local estimate, not a tokenizer.
  exact       only with --tokenize-url: token count from a llama.cpp server's
              /tokenize endpoint, for that server's model, without special tokens.
How the provider serializes tools and how the chat template wraps the messages add
tokens that no part shows; the request total is in the usage the API returns.
"""

import json
import math
import re
import sys
import urllib.request


def chars(text):
    return len(text.encode("utf-16-le")) // 2


def tokenize(url, text):
    body = json.dumps({"content": text, "add_special": False}).encode()
    request = urllib.request.Request(url.rstrip("/") + "/tokenize", body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return len(json.load(response)["tokens"])


def parts_of(dump):
    parts = []
    for message in dump["systemMessages"]:
        content = message["content"]
        if isinstance(content, list):
            content = "\n".join(block.get("text", "") for block in content if block.get("type") == "text")
        if content:
            parts.append(("content", content, True))
        for name, text in message["sections"].items():
            if text is None:
                continue
            parts.append((f"section:{name}", text, True))
            if name == "project_context":
                for path, body in re.findall(r'<project_instructions path="([^"]*)">\n(.*?)\n</project_instructions>', text, re.S):
                    parts.append((f"context:{path}", body, False))
            if name == "skills":
                for block in re.findall(r"  <skill>\n.*?\n  </skill>", text, re.S):
                    skill = re.search(r"<name>(.*?)</name>", block).group(1)
                    parts.append((f"skill:{skill}", block, False))
        for tool in message["toolsAdded"]:
            text = json.dumps(tool, ensure_ascii=False, separators=(",", ":"))
            parts.append((f"tool:{tool['name']}", text, True))
    return parts


def measure(dump, url):
    rows = []
    for name, text, in_total in parts_of(dump):
        row = {"part": name, "chars": chars(text), "estimate": math.ceil(chars(text) / 4), "inTotal": in_total}
        if url:
            row["exact"] = tokenize(url, text)
        rows.append(row)
    total = {key: sum(r[key] for r in rows if r["inTotal"]) for key in ("chars", "estimate", "exact") if not rows or key in rows[0]}
    groups = {}
    for r in rows:
        if r["inTotal"]:
            group = "tools" if r["part"].startswith("tool:") else "system prompt"
            groups[group] = groups.get(group, 0) + r["estimate"]
    return {"parts": rows, "total": total, "estimateByGroup": groups}


def summary(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    print(f"counting: {data['counting']}")
    for name, scenario in data["scenarios"].items():
        exact = "exact" in scenario["total"]
        print(f"\n{name}: total {scenario['total']['estimate']} est." + (f", {scenario['total']['exact']} exact" if exact else ""))
        for row in scenario["parts"]:
            indent = "  " if row["inTotal"] else "    · "
            extra = f" {row['exact']:>6}" if exact else ""
            print(f"  {indent}{row['part']:<40} {row['chars']:>7} ch {row['estimate']:>6}{extra}")
    if "modules-on" in data["scenarios"]:
        module_summary(data["scenarios"])


def module_summary(scenarios):
    """What each module adds: parts of modules-on missing or longer in off:<module>."""
    on = {r["part"]: r for r in scenarios["modules-on"]["parts"] if r["inTotal"]}
    print("\nper module (modules-on minus off:<module>, estimate):")
    for name, scenario in scenarios.items():
        if not name.startswith("off:"):
            continue
        off = {r["part"]: r for r in scenario["parts"] if r["inTotal"]}
        added = [(part, row["estimate"] - off.get(part, {"estimate": 0})["estimate"]) for part, row in on.items()]
        added = [(part, delta) for part, delta in added if delta != 0]
        extra = [part for part in off if part not in on]
        total = scenarios["modules-on"]["total"]["estimate"] - scenario["total"]["estimate"]
        detail = ", ".join(f"{part} {delta:+d}" for part, delta in added) or "nothing"
        print(f"  {name[4:]:<24} {total:>6}  {detail}" + (f"; only when off: {', '.join(extra)}" if extra else ""))


def main(argv):
    if argv[0] == "--summary":
        summary(argv[1])
        return
    url = None
    if argv[0] == "--tokenize-url":
        url, argv = argv[1], argv[2:]
    scenarios = {}
    for arg in argv:
        name, path = arg.split("=", 1)
        with open(path, encoding="utf-8") as f:
            scenarios[name] = measure(json.load(f), url)
    counting = {"estimate": "ceil(chars / 4), pi heuristic, local"}
    if url:
        counting["exact"] = f"llama.cpp /tokenize at {url}, add_special false"
    json.dump({"counting": counting, "scenarios": scenarios}, sys.stdout, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main(sys.argv[1:])
