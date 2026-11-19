#!/usr/bin/env python3
"""Aggregate the probe records of fork/tools/bench.sh into one JSON report (R1.3).

usage: bench-report.py <runs dir> <series> <launches> <command>
       bench-report.py --summary <report.json>
       bench-report.py --conditions   (machine conditions now, as JSON)
"""

import glob
import json
import os
import re
import platform
import statistics
import subprocess
import sys

MODES = ("fullscreen", "regular")
DEFAULT_TRANSCRIPTS = (50, 1000)


def pct(values, p):
    """Nearest-rank percentile."""
    ordered = sorted(values)
    if not ordered:
        return None
    rank = max(1, -(-len(ordered) * p // 100))
    return round(ordered[int(rank) - 1], 3)


def dist(values):
    return {"p50": pct(values, 50), "p95": pct(values, 95), "n": len(values)}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


def conditions():
    """What can make two runs differ on the same machine (R7.4): load, CPU policy, power."""
    ac = read("/sys/class/power_supply/AC/online")
    return {
        "loadAverage": [round(x, 2) for x in os.getloadavg()],
        "governor": read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
        "platformProfile": read("/sys/firmware/acpi/platform_profile"),
        "onAC": None if ac is None else ac == "1",
    }


# Where each F-L2 measure is in a report. "measured": timed in the process by the probe.
F_L2 = {
    "startup": "startupMs (no transcript), transcriptN.startupMs: first frame, ms since process start (measured)",
    "interfaceLatency": "work.keyToFrameMs: key on stdin to end of the next frame; transcriptN.frameMs: frame time while streaming (measured)",
    "memory": "idleRssMiB, transcriptN.loadedRssMiB: RSS 3 s after the first frame (measured)",
    "harnessOverhead": "work.turnHarnessMs: turn wall time minus the time waiting for the fake provider or tools (measured; includes rendering)",
    "toolTime": "work.toolMs: tool_execution_start to tool_execution_end per tool (measured; includes the permission check)",
}


def machine(command):
    cpu = ""
    with open("/proc/cpuinfo", encoding="utf-8") as f:
        for line in f:
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    with open("/proc/meminfo", encoding="utf-8") as f:
        mem_kb = int(f.readline().split()[1])

    def version(*args):
        try:
            return subprocess.run(args, capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL).stdout.strip()
        except OSError:
            return None

    return {
        "os": platform.platform(),
        "cpu": cpu,
        "cpus": os.cpu_count(),
        "memoryGiB": round(mem_kb / 1024 / 1024, 1),
        "node": version("node", "--version"),
        "tmux": version("tmux", "-V"),
        "command": command,
        "version": version(command, "--version"),
    }


def transcript_sizes(runs):
    """The transcript lengths bench.sh ran (--sizes), from the run files' names."""
    sizes = {int(m.group(1)) for f in glob.glob(f"{runs}/s1-*-t*.json") if (m := re.search(r"-t(\d+)\.json$", f))}
    return tuple(sorted(sizes)) or DEFAULT_TRANSCRIPTS


def report(runs, series, launches, command):
    sizes = transcript_sizes(runs)
    start = f"{runs}/conditions-start.json"
    out = {
        "machine": machine(command),
        "conditions": {"start": load(start) if os.path.exists(start) else None, "end": conditions()},
        "measures": F_L2,
        "setup": {"columns": 100, "rows": 40, "launches": launches, "transcripts": list(sizes)},
        "series": [],
    }
    for s in range(1, series + 1):
        entry = {}
        for mode in MODES:
            starts = [load(f"{runs}/s{s}-{mode}-startup-{i}.json")["startup"] for i in range(1, launches + 1)]
            result = {
                "startupMs": {
                    "median": round(statistics.median(x["firstFrameMs"] for x in starts), 1),
                    "min": round(min(x["firstFrameMs"] for x in starts), 1),
                    "max": round(max(x["firstFrameMs"] for x in starts), 1),
                },
                "idleRssMiB": round(statistics.median(x["rssBytes"] for x in starts) / 2**20, 1),
            }
            for n in sizes:
                if not os.path.exists(f"{runs}/s{s}-{mode}-t{n}.json"):
                    continue  # bench.sh --startup-only
                r = load(f"{runs}/s{s}-{mode}-t{n}.json")
                stream = r["stream"]
                result[f"transcript{n}"] = {
                    "startupMs": round(r["startup"]["firstFrameMs"], 1),
                    "loadedRssMiB": round(r["startup"]["rssBytes"] / 2**20, 1),
                    "deltas": stream["deltas"],
                    "frames": stream["frames"],
                    "perDeltaMs": dist(stream["tokenMs"]),
                    "frameMs": dist(stream["frameMs"]),
                    "updateMs": dist(stream["updateMs"]),
                }
            work = f"{runs}/s{s}-{mode}-work.json"
            if os.path.exists(work):  # absent with bench.sh --startup-only
                r = load(work)
                turns = r["turns"]
                tools = {}
                for t in turns:
                    for tool in t["tools"]:
                        if tool["ms"] is not None:
                            tools.setdefault(tool["name"], []).append(tool["ms"])
                result["work"] = {
                    "keyToFrameMs": dist(r["input"]["latencyMs"]),
                    "turns": len(turns),
                    "turnWallMs": dist([t["wallMs"] for t in turns]),
                    "turnProviderMs": dist([t["providerMs"] for t in turns]),
                    "turnHarnessMs": dist([t["harnessMs"] for t in turns]),
                    "toolMs": {name: dist(values) for name, values in sorted(tools.items())},
                }
            entry[mode] = result
        out["series"].append(entry)
    return out


def spread(values):
    """(max - min) / median, in percent."""
    med = statistics.median(values)
    return round((max(values) - min(values)) / med * 100, 1) if med else None


def summary(path):
    data = load(path)
    print(f"{data['machine']['cpu']} · {data['machine']['version']}")
    if "conditions" in data:
        print(f"conditions: start {data['conditions']['start']}, end {data['conditions']['end']}")
    rows = [
        ("startup median ms", lambda m: m["startupMs"]["median"]),
        ("idle RSS MiB", lambda m: m["idleRssMiB"]),
    ]
    for n in data.get("setup", {}).get("transcripts", DEFAULT_TRANSCRIPTS):
        if f"transcript{n}" not in data["series"][0][MODES[0]]:
            continue
        rows += [
            (f"t{n} loaded RSS MiB", lambda m, n=n: m[f"transcript{n}"]["loadedRssMiB"]),
            (f"t{n} per-delta p50 ms", lambda m, n=n: m[f"transcript{n}"]["perDeltaMs"]["p50"]),
            (f"t{n} per-delta p95 ms", lambda m, n=n: m[f"transcript{n}"]["perDeltaMs"]["p95"]),
            (f"t{n} frame p95 ms", lambda m, n=n: m[f"transcript{n}"]["frameMs"]["p95"]),
        ]
    if "work" in data["series"][0][MODES[0]]:
        rows += [
            ("key to frame p50 ms", lambda m: m["work"]["keyToFrameMs"]["p50"]),
            ("key to frame p95 ms", lambda m: m["work"]["keyToFrameMs"]["p95"]),
            ("turn harness p50 ms", lambda m: m["work"]["turnHarnessMs"]["p50"]),
        ]
        for tool in data["series"][0][MODES[0]]["work"]["toolMs"]:
            rows.append((f"tool {tool} p50 ms", lambda m, tool=tool: m["work"]["toolMs"][tool]["p50"]))
    for mode in MODES:
        print(f"\n{mode}: series values, spread (max-min)/median")
        for label, get in rows:
            values = [get(s[mode]) for s in data["series"]]
            print(f"  {label:24} {'  '.join(f'{v:>8}' for v in values)}   {spread(values)}%")


if __name__ == "__main__":
    if sys.argv[1] == "--conditions":
        json.dump(conditions(), sys.stdout)
    elif sys.argv[1] == "--summary":
        summary(sys.argv[2])
    else:
        json.dump(report(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]), sys.stdout, indent=1)
