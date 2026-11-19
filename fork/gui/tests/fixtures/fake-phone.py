#!/usr/bin/env python3
"""A stand-in phone for the scenario qa-phone-open (drive-all.sh): it reaches the window's engines the way the phone
server brings a phone (the hub socket, a hello line), opens one session and holds it until it is killed, reading and
dropping what the engine says. Usage: fake-phone.py HUB_SOCKET SESSION_FILE CWD"""
import json
import socket
import sys

hub, session, cwd = sys.argv[1:4]
phone = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
phone.connect(hub)
phone.sendall((json.dumps({"hello": {"phone": "fake-phone"}}) + "\n").encode())
phone.sendall((json.dumps({"id": "1", "op": "engine_start", "args": {"session": session, "cwd": cwd}}) + "\n").encode())
pending = b""
answered = False
while True:
    chunk = phone.recv(65536)
    if not chunk:
        break
    pending += chunk
    while b"\n" in pending:
        line, pending = pending.split(b"\n", 1)
        if answered:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get("id") == "1":
            answered = True
            print(f"fake-phone: engine_start {json.dumps(record)}", flush=True)
