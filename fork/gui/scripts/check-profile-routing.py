#!/usr/bin/env python3
"""Check launcher profile selection with fake executables; never open the owner's profile."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

gui = Path(__file__).resolve().parents[1]
repo = gui.parents[1]
node = shutil.which("node")
assert node, "Node is required to check the engine's own path resolver"
config = (repo / "packages/coding-agent/src/config.ts").as_uri()
probe = f"import {{APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir}} from {json.dumps(config)}; console.log(JSON.stringify({{pi:process.env.PI_CODING_AGENT_DIR,prism:process.env.PRISM_CODING_AGENT_DIR,effective:getAgentDir(),app:APP_NAME,config:CONFIG_DIR_NAME,key:ENV_AGENT_DIR}}));"
with tempfile.TemporaryDirectory(prefix="prism-profile-check-") as temporary:
    root = Path(temporary)
    home = root / "home"
    home.mkdir()
    binary = root / "bin"
    binary.mkdir()
    fake = """#!/usr/bin/python3
import json, os, sys
from pathlib import Path
if len(sys.argv) > 1 and sys.argv[1] == '-p':
    print(Path(sys.argv[-1]).as_uri())
elif len(sys.argv) > 1 and sys.argv[1] == '-e' and 'writeFileSync' in sys.argv[2]:
    import subprocess
    subprocess.run([os.environ['PROFILE_CHECK_NODE'], *sys.argv[1:]], check=True)  # run.sh's package.json named prism
elif len(sys.argv) > 1 and sys.argv[1] == '-e':
    print('[]')
elif any(arg.endswith('/local-profile.ts') for arg in sys.argv):
    pass  # Model discovery is outside this profile test; do not contact a server.
else:
    import subprocess
    subprocess.run([os.environ['PROFILE_CHECK_NODE'], '--input-type=module', '-e', os.environ['PROFILE_CHECK_CODE']], check=True)
"""
    for name in ("node", "gui"):
        file = binary / name
        file.write_text(fake)
        file.chmod(0o700)
    environment = {
        "PATH": f"{binary}:/usr/bin:/bin",
        "HOME": str(home),
        "PRISM_GUI_BIN": str(binary / "gui"),
        "PRISM_GUI_PROFILE_DIR": str(root / "profiles"),
        # An inherited pi profile must not send Prism's user mode back to pi.
        "PI_CODING_AGENT_DIR": str(root / "old-pi-profile"),
        "PROFILE_CHECK_NODE": node,
        "PROFILE_CHECK_CODE": probe,
    }
    branded = root / "branded-package"
    branded.mkdir()
    shutil.copyfile(repo / "packages/coding-agent/package.json", branded / "package.json")
    (branded / "pi").write_bytes(b"test placeholder, never executed")
    subprocess.run([str(repo / "fork/scripts/brand-binary.sh"), str(branded), "10"], env={"HOME": str(home), "PATH": f"{Path(node).parent}:/usr/bin:/bin"}, check=True, capture_output=True, text=True)
    checks = 0
    # run.sh always runs the engine under the Prism name (a package.json named prism), as a shipped Prism does.
    launched = {"app": "prism", "config": ".prism", "key": "PRISM_CODING_AGENT_DIR"}
    for packaged in (False, True):
        base = dict(environment)
        if packaged:
            base["PI_PACKAGE_DIR"] = str(branded)
        identity = {"app": "prism" if packaged else "pi", "config": ".prism" if packaged else ".pi", "key": "PRISM_CODING_AGENT_DIR" if packaged else "PI_CODING_AGENT_DIR"}
        # Without the QA launcher, the source and branded package have different defaults.
        clean = {key: value for key, value in base.items() if key not in ("PI_CODING_AGENT_DIR", "PRISM_CODING_AGENT_DIR")}
        raw = json.loads(subprocess.run([node, "--input-type=module", "-e", probe], env=clean, check=True, capture_output=True, text=True).stdout)
        assert raw == {**identity, "effective": str(home / identity["config"] / "agent")}, raw
        checks += 1
        for terminal in (False, True):
            for custom in (None, root / "custom-prism-profile"):
                env = dict(base)
                if custom:
                    env["PRISM_CODING_AGENT_DIR"] = str(custom)
                result = subprocess.run([str(gui / "scripts/run.sh"), "user", *(["--terminal"] if terminal else [])], env=env, cwd=root, check=True, capture_output=True, text=True)
                actual = json.loads(result.stdout)
                expected = str(custom or home / ".prism/agent")
                assert actual == {**launched, "pi": expected, "prism": expected, "effective": expected}, actual
                checks += 1
            for mode, args in (("demo", []), ("empty", []), ("local", ["http://127.0.0.1:1/v1", "test-model"])):
                env = {**base, "PRISM_CODING_AGENT_DIR": str(root / "old-prism-profile")}
                result = subprocess.run([str(gui / "scripts/run.sh"), mode, *args, *(["--terminal"] if terminal else [])], env=env, cwd=root, check=True, capture_output=True, text=True)
                expected = str(root / f"profiles/{mode}/agent")
                assert json.loads(result.stdout) == {**launched, "pi": expected, "prism": expected, "effective": expected}
                checks += 1
    assert not (home / ".pi").exists()
    assert not (home / ".prism").exists()
    print(f"{checks} profile routing checks passed; no personal profile opened.")
