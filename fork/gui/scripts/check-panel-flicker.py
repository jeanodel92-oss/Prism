#!/usr/bin/env python3
"""Capture actual panel dropouts on Hyprland's hidden test output (requires Pillow).

Build with build.sh --drive, then run under a memory cap:
systemd-run --user --scope -q -p MemoryMax=3G -p MemorySwapMax=0 -- \
  python3 fork/gui/scripts/check-panel-flicker.py /tmp/prism-panel-check [1280x800@1]
The output directory must be new. Screenshots, timings and an isolated profile stay there.
"""

from collections import deque
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from PIL import Image, ImageChops, ImageStat


def difference(left, right):
    return sum(ImageStat.Stat(ImageChops.difference(left, right)).mean) / 3


def main():
    root = Path(__file__).resolve().parents[3]
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True)
    geometry = sys.argv[2] if len(sys.argv) > 2 else '1280x800@1'
    steps = [
        {'do': 'wait', 'selector': '#composer[data-starting="false"]', 'timeout': 30000},
        {'do': 'sleep', 'ms': 1500},
    ]
    for index in range(10):
        for command, panel in [('help', '.panel.help'), ('session', '.panel.report')]:
            steps.append({'do': 'log', 'text': f'opening {command} {index}'})
            if index == 0:
                steps.append({'do': 'surface-trace', 'ms': 400})
            steps.extend([
                {'do': 'type', 'text': f'/{command}'},
                {'do': 'send'},
                {'do': 'wait', 'selector': panel},
                {'do': 'sleep', 'ms': 800},
                {'do': 'key', 'selector': panel, 'key': 'Escape'},
                {'do': 'wait', 'selector': panel, 'gone': True},
                {'do': 'sleep', 'ms': 300},
            ])
    steps.append({'do': 'quit'})
    scenario = out / 'scenario.json'
    scenario.write_text(json.dumps(steps))
    started = time.monotonic()
    openings = []
    with (out / 'drive.log').open('w') as log:
        process = subprocess.Popen(
            [str(root / 'fork/gui/scripts/drive.sh'), str(scenario), str(out / 'shots'), geometry, '--', 'demo'],
            cwd=root, env=dict(os.environ, PRISM_GUI_PROFILE_DIR=str(out / 'profile')),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', start_new_session=True,
        )

        def logs():
            for line in process.stdout:
                elapsed = time.monotonic() - started
                log.write(f'{elapsed:.3f} {line}')
                log.flush()
                if 'drive: opening ' in line:
                    openings.append((elapsed, line.strip()))

        reader = threading.Thread(target=logs, daemon=True)
        reader.start()
        frames = deque(maxlen=3)
        anomalies = []
        captured = 0
        try:
            while process.poll() is None:
                if time.monotonic() - started > 90:
                    raise TimeoutError('scenario exceeded 90 seconds')
                try:
                    result = subprocess.run(['grim', '-o', 'PRISMTEST', '-t', 'ppm', '-'], capture_output=True, timeout=3)
                except subprocess.TimeoutExpired:
                    if process.poll() is not None:
                        break
                    raise
                if result.returncode:
                    time.sleep(0.05)
                    continue
                shot = Image.open(io.BytesIO(result.stdout)).convert('RGB')
                # Exclude the desktop's bar: only the test window is compared.
                grid = shot.crop((0, 40, shot.width, shot.height)).resize((160, 100))
                elapsed = time.monotonic() - started
                frames.append((elapsed, shot, grid))
                captured += 1
                if len(frames) < 3 or not openings:
                    continue
                before, current, after = frames
                neighbors = difference(before[2], after[2])
                spike = min(difference(current[2], side[2]) for side in (before, after))
                # shortcut: samples can miss a frame; use continuous recording during final human QA.
                # A single bad frame between two near-identical ones, not a normal fade or a closing panel.
                if spike > 1 and neighbors < 0.35:
                    name = f'{len(anomalies):02d}-{current[0]:.3f}'
                    if len(anomalies) < 20:
                        for label, frame in zip(('before', 'spike', 'after'), frames):
                            frame[1].save(out / f'{name}-{label}.png')
                    anomalies.append({'time': current[0], 'spike': spike, 'neighbors': neighbors, 'opening': openings[-1], 'images': name})
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            reader.join(timeout=2)
        summary = {'frames': captured, 'seconds': time.monotonic() - started, 'openings': len(openings), 'exit': process.returncode, 'anomalies': anomalies}
        (out / 'capture.json').write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary))
        recorded = (out / 'drive.log').read_text()
        assert process.returncode == 0 and len(openings) == 20 and 'drive: done' in recorded and 'drive: FAIL' not in recorded, 'scenario incomplete; inspect drive.log'
        assert captured >= 400, 'capture too sparse to assess a one-frame dropout'
        assert not anomalies, 'panel dropout captured; inspect the saved image triplets'


if __name__ == '__main__':
    main()
