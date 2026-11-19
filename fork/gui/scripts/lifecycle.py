#!/usr/bin/env python3
"""Engine lifecycle (fork.10): one engine per conversation, measured as conversations open and close.

  lifecycle.py [SCENARIO.json [LOG]]   default tests/lifecycle.json, demo profile, through drive.sh;
                                       LOG keeps the window's whole output

At each "measure LABEL" line of the scenario, during the pause that follows it: the engine processes
under the window, the window's and the engines' memory (PSS, as measure.py) and their CPU over 5 s.
After the window has quit: every process still running with the throwaway profile in its environment
(engines, and anything an engine started) is an orphan. Run it on an otherwise idle machine, under a
memory cap; numbers are measurements of this machine, not targets.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

from measure import GUI, TICK, children, cpu_ticks, is_engine, pss_kb, started_at


def started(pid):
    try:
        return started_at(pid)
    except OSError:
        return 0


def sample(root):
    tree = children(root)
    window = [p for p in tree if not is_engine(p)]
    engines = [p for p in tree if is_engine(p)]
    # The engines are the window's direct children; what they start (none in the demo profile) is theirs.
    direct = [p for p in engines if p in children_of(root)]
    return window, engines, direct


def children_of(pid):
    out = []
    try:
        for task in os.listdir(f"/proc/{pid}/task"):
            with open(f"/proc/{pid}/task/{task}/children") as f:
                out += [int(c) for c in f.read().split()]
    except OSError:
        pass
    return out


def measure(root):
    time.sleep(2)
    window, engines, direct = sample(root)
    ticks = {p: cpu_ticks(p) for p in window + engines}
    time.sleep(5)
    each = {p: (cpu_ticks(p) - ticks[p]) / TICK / 5 * 100 for p in ticks}
    cpu = lambda pids: sum(each[p] for p in pids if p in each)
    busy = sorted((each[p] for p in direct), reverse=True)
    return {
        "engines": len(direct),
        "window_mb": round(sum(map(pss_kb, window)) / 1024),
        "engines_mb": round(sum(map(pss_kb, engines)) / 1024),
        "engine_mb_each": round(sum(map(pss_kb, engines)) / 1024 / len(direct)) if direct else 0,
        "window_cpu_pct": round(cpu(window), 1),
        "engines_cpu_pct": round(cpu(engines), 1),
        # Whether idle engines cost CPU, or only the newest one, still finishing its start.
        "engines_cpu_busiest": [round(c, 1) for c in busy[:3]],
        "newest_engine_cpu_pct": round(each.get(max(direct, key=started), 0), 1) if direct else 0,
    }


def with_profile(profile):
    """Processes of this user whose environment names the throwaway profile."""
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        try:
            with open(f"/proc/{entry}/environ", "rb") as f:
                if profile.encode() in f.read():
                    with open(f"/proc/{entry}/cmdline", "rb") as c:
                        found.append(f"{entry} {c.read().replace(b'\0', b' ').decode(errors='replace')[:120]}")
        except OSError:
            pass
    return found


def main():
    scenario = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else f"{GUI}/tests/lifecycle.json")
    scratch = tempfile.mkdtemp(prefix="prism-gui-lifecycle.")
    env = dict(os.environ, PRISM_GUI_PROFILE_DIR=scratch)
    proc = subprocess.Popen([f"{GUI}/scripts/drive.sh", scenario, f"{scratch}/shots", "1280x800@1", "--", "demo"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    window = None
    ok = False
    log = open(sys.argv[2], "w") if len(sys.argv) > 2 else None
    for line in proc.stdout:
        if log:
            log.write(f"{time.monotonic():.1f} {line}")
        if "FAIL" in line:
            print(line.strip(), flush=True)
        if "lifecycle-ok" in line:
            ok = True
        m = re.search(r"drive: measure (\S+)", line)
        if not m:
            continue
        if window is None:
            window = int(subprocess.check_output(["pgrep", "-n", "-f", "target-drive/release/prism-gui"], text=True))
        print(json.dumps({"open": m.group(1), **measure(window)}), flush=True)
    proc.wait()
    # Processes still there when the window has quit: how long they take to go, up to 10 s, then orphans.
    quit_at = time.time()
    while (orphans := with_profile(scratch)) and time.time() - quit_at < 10:
        time.sleep(0.1)
    released = round(time.time() - quit_at, 1)
    print(json.dumps({"scenario_ok": ok, "released_after_quit_s": released, "orphans": orphans}), flush=True)
    shutil.rmtree(scratch, ignore_errors=True)
    sys.exit(0 if ok and not orphans else 1)


if __name__ == "__main__":
    main()
