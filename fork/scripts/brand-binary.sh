#!/usr/bin/env bash
# Apply the fork identity to a standalone binary built by scripts/build-binaries.sh.
#
# usage: fork/scripts/brand-binary.sh <platform-dir> [fork-number]
#   e.g. fork/scripts/brand-binary.sh /tmp/pi-bin/linux-x64 1
#
# The binary reads package.json next to it at runtime (src/config.ts), so setting
# piConfig there renames the command, the env var prefix (PRISM_CODING_AGENT_DIR)
# and the config dir (~/.prism) without touching upstream sources. The source tree
# keeps upstream's defaults so upstream tests keep passing.
#
# The version becomes <upstream version>-fork.<fork-number> (default 1), shown by
# --version and in the header.
set -euo pipefail

dir=${1:?usage: brand-binary.sh <platform-dir> [fork-number]}
fork_number=${2:-1}
[[ "$fork_number" =~ ^[1-9][0-9]*$ ]] || {
	echo "brand-binary: fork-number must be a positive integer, got '$fork_number'" >&2
	exit 1
}
[[ -f "$dir/package.json" && -f "$dir/pi" ]] || {
	echo "brand-binary: $dir must contain package.json and the pi binary" >&2
	exit 1
}

node -e '
const fs = require("node:fs");
const [path, forkNumber] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.piConfig = { ...pkg.piConfig, name: "prism", configDir: ".prism" };
pkg.version = `${pkg.version.replace(/-fork\.\d+$/, "")}-fork.${forkNumber}`;
fs.writeFileSync(path, `${JSON.stringify(pkg, null, "\t")}\n`);
' "$dir/package.json" "$fork_number"
mv "$dir/pi" "$dir/prism"
echo "brand-binary: $dir/prism ($(node -p "require(process.argv[1]).version" "$dir/package.json"))"
