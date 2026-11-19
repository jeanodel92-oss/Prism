#!/usr/bin/env python3
"""D1 measurements (fork.10): start-up, idle memory and idle CPU of a window and its engine.

  measure.py tauri SCENARIO.json [RUNS]   the Tauri test variant through drive.sh, demo profile

Memory is PSS (shared pages split between processes) summed over the process tree, split into the
window (the GUI process and its WebKit processes) and the engine (node). CPU is the
user+system time used by the window processes between seconds 6 and 11 after the window is ready.
Run it on an otherwise idle machine; numbers are measurements of this machine, not targets.
"""

import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

GUI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(GUI))
TICK = os.sysconf("SC_CLK_TCK")


def children(pid):
    out, todo = [], [pid]
    while todo:
        p = todo.pop()
        out.append(p)
        try:
            for task in os.listdir(f"/proc/{p}/task"):
                with open(f"/proc/{p}/task/{task}/children") as f:
                    todo += [int(c) for c in f.read().split()]
        except OSError:
            pass
    return out


def name(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().split(b"\0")[0].decode(errors="replace")
    except OSError:
        return ""


def pss_kb(pid):
    try:
        with open(f"/proc/{pid}/smaps_rollup") as f:
            return int(re.search(r"^Pss:\s+(\d+)", f.read(), re.M).group(1))
    except (OSError, AttributeError):
        return 0


def cpu_ticks(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        return int(fields[11]) + int(fields[12])
    except OSError:
        return 0


def is_engine(pid):
    # The engine renames its process ("pi"); its command line still starts with node or that name.
    return os.path.basename(name(pid)) in ("node", "pi", "prism")


def started_at(pid):
    """Wall-clock start of a process, from its start time in jiffies after boot."""
    with open("/proc/stat") as f:
        boot = int(re.search(r"^btime (\d+)", f.read(), re.M).group(1))
    with open(f"/proc/{pid}/stat") as f:
        return boot + int(f.read().rsplit(")", 1)[1].split()[19]) / TICK


def sample(root):
    tree = children(root)
    window = [p for p in tree if not is_engine(p)]
    engine = [p for p in tree if is_engine(p)]
    return {
        "window_mb": sum(map(pss_kb, window)) / 1024,
        "engine_mb": sum(map(pss_kb, engine)) / 1024,
        "window_ticks": sum(map(cpu_ticks, window)),
        "processes": [os.path.basename(name(p)) for p in tree],
    }


def run_tauri(scenario, scratch):
    env = dict(os.environ, PRISM_GUI_PROFILE_DIR=scratch)
    shutil.rmtree(f"{scratch}/demo", ignore_errors=True)
    proc = subprocess.Popen([f"{GUI}/scripts/drive.sh", scenario, f"{scratch}/shots", "1280x800@1", "--", "demo"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    ready = None
    window_pid = None
    result = {}
    for line in proc.stdout:
        m = re.search(r"stamp ready navigation=(\d+) now=(\d+)", line)
        if m:
            ready = int(m.group(2)) / 1000
            window_pid = int(subprocess.check_output(["pgrep", "-n", "-f", "target-drive/release/prism-gui"], text=True))
            launched = started_at(window_pid)
            result["page_start_ms"] = int(m.group(1)) - launched * 1000
            result["ready_ms"] = (ready - launched) * 1000
            measure_idle(window_pid, ready, result)
        if "FAIL" in line:
            result["error"] = line.strip()
    proc.wait()
    return result


def measure_idle(root, ready, result):
    time.sleep(max(0, ready + 6 - time.time()))
    first = sample(root)
    time.sleep(5)
    second = sample(root)
    result["window_mb"] = round(second["window_mb"], 1)
    result["engine_mb"] = round(second["engine_mb"], 1)
    result["window_cpu_pct"] = round((second["window_ticks"] - first["window_ticks"]) / TICK / 5 * 100, 1)
    result["processes"] = second["processes"]


def main():
    if sys.argv[1] != "tauri":
        sys.exit(__doc__)
    runs = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    scratch = tempfile.mkdtemp(prefix="prism-gui-measure.")
    results = []
    for _ in range(runs):
        results.append(run_tauri(os.path.abspath(sys.argv[2]), scratch))
        print(json.dumps(results[-1]), flush=True)
        time.sleep(2)
    keys = [k for k in results[0] if isinstance(results[0][k], (int, float))]
    print("median", json.dumps({k: round(statistics.median(r[k] for r in results if k in r), 1) for k in keys}))
    shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
