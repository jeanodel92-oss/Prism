#!/bin/sh
# Prism installer, served at https://prism.odelserver.space/install.sh.
#
#   curl -fsSL https://prism.odelserver.space/install.sh | sh
#
# Downloads the latest linux-x64 release, checks the minisign signature of its
# SHA256SUMS against the public key embedded below, checks the archive against
# SHA256SUMS, then installs it for the current user, without sudo:
#
#   $PRISM_INSTALL_DIR (default ~/.local/share/prism)   the releases, Node included:
#       versions/<version>-<stamp>/   one directory per installed release
#       current, previous             links to the release in use and the one before
#   $PRISM_BIN_DIR/prism (default ~/.local/bin/prism)   a link to current/prism
#
# Nothing is extracted before both checks pass, and the new release is switched in
# with a rename, so a failed or interrupted run leaves the installed one working.
# The signature is checked with minisign when it is installed, otherwise with
# openssl (3.0 or later). Your config in ~/.prism is never touched.
#
#   sh install.sh --update       install the latest release if it is newer
#                                and print its release notes (what `prism update` runs;
#                                leaves the command link alone)
#   sh install.sh --check        only say whether a newer release exists
#   sh install.sh --rollback     go back to the previous release (again: undo)
#   sh install.sh --uninstall    remove the installation and its link
#
# Release channels: stable (the default) installs the releases listed in
# releases/LATEST, versioned <upstream>-fork.<n>. canary installs the newer of
# releases/LATEST-canary and releases/LATEST; canary releases are versioned
# <upstream>-fork.<n>.canary.<m> (the m-th after stable n) and their signature's
# trusted comment ends in " canary", so a stable installation refuses them
# whatever LATEST says. They are signed with their own key (PRISM_CANARY_PUBLIC_KEY),
# which only signs canaries and is trusted for nothing else: stable releases must carry
# the release key's signature. The channel is kept in $PRISM_INSTALL_DIR/channel.
#
#   sh install.sh --channel canary             install on the canary channel
#   sh install.sh --update --channel stable    switch channel and update; going back
#                                              to an older stable release is allowed
#                                              then (your config is kept)
#
# Environment: PRISM_BASE_URL (default https://prism.odelserver.space),
# PRISM_VERSION (default: the channel's latest release; with --update, also allows
# an older one), PRISM_INSTALL_DIR, PRISM_BIN_DIR.

# Everything runs from main, called on the last line, so a truncated download
# of this script runs nothing.

PRISM_PUBLIC_KEY=RWQHj1LfelCE8N3pmVRt9kJcLo18AA41Gm8c7heF0irUFX2+UNOKpPHf
# the canary releases' key, held by the build server only.
PRISM_CANARY_PUBLIC_KEY=RWSWxch0cx1AagI3TOgfwXv2dU/QF+mah75kGskd/HrnYZBTpa6JvJxm
MARKER=".prism-install"

say() { printf 'prism-install: %s\n' "$*"; }
die() {
	printf 'prism-install: %s\n' "$*" >&2
	exit 1
}

# Bytes [skip, skip + count) of a file, on stdout.
bytes() { dd if="$1" bs=1 skip="$2" count="$3" 2>/dev/null; }
hex() { od -An -v -tx1 | tr -d ' \n'; }

# Verifies a minisign signature with openssl: Ed25519 over the BLAKE2b-512 hash of
# the file ("ED"), or over the file itself (legacy "Ed"), then the global
# signature over the signature and the trusted comment. Prints the trusted comment.
# usage: verify_openssl FILE SIGNATURE WORK-DIR PUBLIC-KEY
verify_openssl() {
	file=$1
	sig=$2
	work=$3
	printf '%s\n' "$4" | base64 -d >"$work/key.bin" 2>/dev/null || return 1
	sed -n 2p "$sig" | base64 -d >"$work/sig.bin" 2>/dev/null || return 1
	[ "$(wc -c <"$work/key.bin" | tr -d ' ')" = 42 ] || return 1
	[ "$(wc -c <"$work/sig.bin" | tr -d ' ')" = 74 ] || return 1
	[ "$(bytes "$work/key.bin" 0 2)" = Ed ] || return 1
	[ "$(bytes "$work/key.bin" 2 8 | hex)" = "$(bytes "$work/sig.bin" 2 8 | hex)" ] || return 1
	# SubjectPublicKeyInfo DER prefix for Ed25519 (12 bytes, so the base64 concatenates).
	{
		printf '%s\n' '-----BEGIN PUBLIC KEY-----'
		printf 'MCowBQYDK2VwAyEA%s\n' "$(bytes "$work/key.bin" 10 32 | base64 | tr -d '\n')"
		printf '%s\n' '-----END PUBLIC KEY-----'
	} >"$work/key.pem"
	bytes "$work/sig.bin" 10 64 >"$work/file.sig"
	case $(bytes "$work/sig.bin" 0 2) in
	ED) openssl dgst -blake2b512 -binary "$file" >"$work/signed" || return 1 ;;
	Ed) cp "$file" "$work/signed" ;;
	*) return 1 ;;
	esac
	openssl pkeyutl -verify -pubin -inkey "$work/key.pem" -rawin -in "$work/signed" \
		-sigfile "$work/file.sig" >/dev/null 2>&1 || return 1

	sed -n 1p "$sig" | grep -q '^untrusted comment: ' || return 1
	trusted=$(sed -n 3p "$sig")
	case $trusted in "trusted comment: "*) ;; *) return 1 ;; esac
	comment=${trusted#trusted comment: }
	sed -n 4p "$sig" | base64 -d >"$work/global.sig" 2>/dev/null || return 1
	{
		cat "$work/file.sig"
		printf '%s' "$comment"
	} >"$work/global"
	openssl pkeyutl -verify -pubin -inkey "$work/key.pem" -rawin -in "$work/global" \
		-sigfile "$work/global.sig" >/dev/null 2>&1 || return 1
	printf '%s\n' "$comment"
}

# Prints the trusted comment of a valid signature by PUBLIC-KEY; fails otherwise.
# usage: verify_signature FILE SIGNATURE WORK-DIR PUBLIC-KEY
verify_signature() {
	if command -v minisign >/dev/null 2>&1; then
		minisign -V -Q -P "$4" -m "$1" -x "$2" 2>/dev/null
	else
		verify_openssl "$@"
	fi
}

# The key a release of channel $1 must be signed with: each channel has its own, so the canary key, held by the build
# server, cannot sign a stable release, nor the release key a canary.
release_key() {
	if [ "$1" = canary ]; then
		printf '%s\n' "$PRISM_CANARY_PUBLIC_KEY"
	else
		printf '%s\n' "$PRISM_PUBLIC_KEY"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		openssl dgst -sha256 -r "$1" | cut -d' ' -f1
	fi
}

fetch() {
	curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1" ||
		die "cannot download $1: check the network connection, or try again later"
}

# The installation directory holds one directory per installed release under
# versions/, and two links: current (the release in use) and previous (the one
# before it, for --rollback). Switching a link is a rename, so it is atomic: a
# running prism keeps its files, and a new one starts on the old or the new
# release, never on a mix.
switch_link() {
	ln -sfn "$2" "$INSTALL_DIR/$1.new.$$"
	mv -T -- "$INSTALL_DIR/$1.new.$$" "$INSTALL_DIR/$1"
}

current_version() {
	[ -x "$INSTALL_DIR/current/prism" ] && "$INSTALL_DIR/current/prism" --version 2>/dev/null
}

# Is $1 strictly older than $2?
older_than() {
	[ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

# The channel a version belongs to, from its name.
version_channel() {
	case $1 in
	*.canary.*) echo canary ;;
	*) echo stable ;;
	esac
}

# The channel recorded in a file (channel or previous-channel); stable when there is none.
read_channel() {
	case $(head -n 1 "$1" 2>/dev/null || true) in
	canary) echo canary ;;
	*) echo stable ;;
	esac
}

write_channel() {
	printf '%s\n' "$2" >"$INSTALL_DIR/$1.new.$$"
	mv -- "$INSTALL_DIR/$1.new.$$" "$INSTALL_DIR/$1"
}

valid_version() {
	printf '%s\n' "$1" | grep -Eq '^[0-9A-Za-z.+-]+$'
}

canary_warning() {
	say "canary channel: experimental releases, they can break; back to stable with: prism update --channel stable"
}

# Remove a previous installation, but only a directory a Prism installer created.
remove_install_dir() {
	[ -e "$INSTALL_DIR" ] || return 0
	[ -f "$INSTALL_DIR/$MARKER" ] || die "$INSTALL_DIR exists but was not created by the Prism installer; remove it yourself"
	rm -rf -- "$INSTALL_DIR"
}

# Remove the applications-menu entry the window offers (prism --gui), and its icon, and the desktop portal's hidden
# entry; never another file of those names.
remove_menu_entry() {
	data=${XDG_DATA_HOME:-$HOME/.local/share}
	entry="$data/applications/prism.desktop"
	# The hidden entry Prism writes so the desktop portal recognises it, marked as Prism's.
	portal="$data/applications/space.odelserver.prism.gui.desktop"
	[ -f "$portal" ] && grep -qx 'X-Prism-Portal=true' "$portal" && rm -f -- "$portal"
	[ -f "$entry" ] && prism_menu_entry "$entry" || return 0
	rm -f -- "$entry" "$data/icons/hicolor/256x256/apps/prism.png"
}

# fork: the menu entry Prism wrote (src/fork/launch-interface.ts), never a user's
# own prism.desktop that merely mentions --gui: its marker line or, written before the marker, exactly
# Prism's lines but its command and icon.
prism_menu_entry() {
	grep -qx 'X-Prism-Menu=true' "$1" && return 0
	grep -q '^Exec=.* --gui$' "$1" || return 1
	[ "$(grep -v -e '^Exec=' -e '^Icon=' "$1")" = "$(printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Prism' \
		'Comment=AI coding agent' 'Terminal=false' 'Categories=Development;' 'StartupNotify=true')" ]
}

# The sandbox for the agent's commands runs them in bubblewrap (offered like the window's libraries)
# . Without it, commands stay blocked while the sandbox is on; checked at every install and update.
sandbox_program() {
	command -v bwrap >/dev/null 2>&1 && return 0
	command=$(package_command bubblewrap bubblewrap bubblewrap bubblewrap)
	if [ -z "$command" ]; then
		say "the sandbox for the agent's commands needs bubblewrap: install the bubblewrap package; until then commands stay blocked while the sandbox is on"
		return 0
	fi
	say "the sandbox for the agent's commands needs bubblewrap: $command"
	say "until then commands stay blocked while the sandbox is on"
	offer_command "$command"
}

# Remove the link, but only if it points into the installation directory.
# The window (gui/prism-gui) uses the system's WebKitGTK 4.1 and GTK 3 (LIV-02): nothing to build, but a system
# without them gets told which package to install; until then Prism opens in the terminal.
window_libraries() {
	gui="$INSTALL_DIR/current/gui/prism-gui"
	[ -x "$gui" ] && command -v ldd >/dev/null 2>&1 || return 0
	missing=$(ldd "$gui" 2>/dev/null | awk '/not found/ { printf "%s ", $1 }')
	[ -n "$missing" ] || return 0
	say "the window (prism --gui) needs libraries this system does not have: ${missing% }"
	# the one command for this distribution, run on the user's yes.
	command=$(package_command webkit2gtk-4.1 webkit2gtk4.1 libwebkit2gtk-4.1-0 libwebkit2gtk-4_1-0)
	if [ -z "$command" ]; then
		say "install WebKitGTK 4.1: libwebkit2gtk-4.1-0 (Debian, Ubuntu), webkit2gtk4.1 (Fedora), webkit2gtk-4.1 (Arch), libwebkit2gtk-4_1-0 (openSUSE); until then Prism opens in the terminal"
		return 0
	fi
	say "install WebKitGTK 4.1 with: $command"
	say "until then Prism opens in the terminal"
	offer_command "$command"
}

# the agent's own desktop is a labwc that Prism starts, driven by the shipped helper, which needs
# libwayland-client (a labwc dependency). The module is off by default, so this is offered on a first install only.
desktop_libraries() {
	helper="$INSTALL_DIR/current/desktop/prism-desktop-helper"
	missing=""
	if [ -x "$helper" ] && command -v ldd >/dev/null 2>&1; then
		missing=$(ldd "$helper" 2>/dev/null | awk '/not found/ { printf "%s ", $1 }')
	fi
	command -v labwc >/dev/null 2>&1 && [ -z "$missing" ] && return 0
	command=$(package_command labwc labwc labwc labwc)
	if [ -z "$command" ]; then
		say "the agent's desktop (off by default, /settings > Modules) needs labwc: install the labwc package to use it"
		return 0
	fi
	say "the agent's desktop (off by default, /settings > Modules) needs labwc: $command"
	offer_command "$command"
}

# under GNOME and KDE, the agent uses the user's desktop through the desktop portal, with the shipped
# prism-portal-helper, which needs libei and PipeWire (and GLib and xkbcommon, which a desktop has). Same module, off by
# default: offered on a first install only.
portal_libraries() {
	helper="$INSTALL_DIR/current/desktop/prism-portal-helper"
	[ -x "$helper" ] && command -v ldd >/dev/null 2>&1 || return 0
	missing=$(ldd "$helper" 2>/dev/null | awk '/not found/ { printf "%s ", $1 }')
	[ -n "$missing" ] || return 0
	say "letting the agent use your desktop under GNOME or KDE (off by default, /settings > Modules) needs libraries this system does not have: ${missing% }"
	command=$(package_command "libei libpipewire glib2 libxkbcommon" "libei pipewire-libs glib2 libxkbcommon" \
		"libei1 libpipewire-0.3-0t64 libglib2.0-0t64 libxkbcommon0" "libei1 libpipewire-0_3-0 libgio-2_0-0 libxkbcommon0")
	if [ -z "$command" ]; then
		say "install libei and the PipeWire library to use it"
		return 0
	fi
	# Debian 12 and Ubuntu 22.04 have no libei package: apt would refuse the whole command.
	case $command in "sudo apt "*)
		if apt_lacks libei1; then
			say "this system has no libei package (Debian 12, Ubuntu 22.04 and older): this does not work here"
			return 0
		fi
		;;
	esac
	say "install them with: $command"
	offer_command "$command"
}

# The package lists are there and do not know this package. Without lists (never updated), apt cannot tell.
apt_lacks() {
	set -- "$1" /var/lib/apt/lists/*_Packages*
	[ -e "$2" ] && command -v apt-cache >/dev/null 2>&1 && ! apt-cache show "$1" >/dev/null 2>&1
}

# Runs a command on the user's yes. Through curl | sh, stdin is the script: the answer comes from the terminal,
# when there is one; without one, nothing is run.
offer_command() {
	if [ -t 2 ] && { : </dev/tty; } 2>/dev/null; then
		printf 'prism-install: run it now? [y/N] ' >&2
		read -r answer </dev/tty || answer=
		case "$answer" in
		y | Y | yes | o | O | oui) $1 || say "the command failed; run it yourself: $1" ;;
		esac
	fi
}

# The command that installs a package on this distribution (/etc/os-release), or nothing when it is not known.
# Arguments: the package's name on Arch, Fedora, Debian and Ubuntu, then openSUSE.
package_command() {
	[ -r /etc/os-release ] || return 0
	ids=$(. /etc/os-release 2>/dev/null && printf '%s %s' "${ID:-}" "${ID_LIKE:-}")
	for id in $ids; do
		case "$id" in
		arch | cachyos | manjaro | endeavouros) echo "sudo pacman -S --needed $1" && return 0 ;;
		fedora | rhel | centos) echo "sudo dnf install $2" && return 0 ;;
		debian | ubuntu) echo "sudo apt install $3" && return 0 ;;
		opensuse* | suse) echo "sudo zypper install $4" && return 0 ;;
		esac
	done
}

remove_link() {
	link="$BIN_DIR/prism"
	[ -e "$link" ] || [ -L "$link" ] || return 0
	if [ -L "$link" ]; then
		case $(readlink "$link") in "$INSTALL_DIR"/*) rm -f -- "$link" && return 0 ;; esac
	fi
	die "$link is not a link created by the Prism installer; remove it yourself"
}

# One installer at a time changes an installation: another one's pruning could
# remove the release this one is about to switch to. The lock is a file next to the installation, so replacing an old
# layout keeps it; an uninstall removes it.
lock_install() {
	command -v flock >/dev/null 2>&1 || die "flock (util-linux) is required"
	mkdir -p "$(dirname "$INSTALL_DIR")"
	exec 9>>"$INSTALL_DIR.lock"
	flock -n 9 && return 0
	say "waiting for another Prism installation or update to finish"
	flock 9
}

# Keep the releases current and previous point to, and those a running process was started from (a session that outlives two updates still finds its files)
# ; a later update removes them once their processes ended.
prune_versions() {
	keep_current=$(readlink "$INSTALL_DIR/current" 2>/dev/null || true)
	keep_previous=$(readlink "$INSTALL_DIR/previous" 2>/dev/null || true)
	# The program files of this user's processes: the bundled node, the window, the desktop helper.
	running=$(ls -l /proc/[0-9]*/exe 2>/dev/null | sed -n 's/.* -> //p')
	for dir in "$INSTALL_DIR"/versions/*; do
		[ -e "$dir" ] || continue
		rel="versions/${dir##*/}"
		[ "$rel" = "$keep_current" ] || [ "$rel" = "$keep_previous" ] || in_use "$dir" || rm -rf -- "$dir"
	done
}

# Is a program file of $running (one per line) under the directory $1?
in_use() {
	real=$(cd -P -- "$1" && pwd -P) || return 1
	case "
$running" in *"
$real/"*) return 0 ;; esac
	return 1
}

rollback() {
	[ -f "$INSTALL_DIR/$MARKER" ] && [ -L "$INSTALL_DIR/current" ] || die "no Prism installation in $INSTALL_DIR"
	[ -L "$INSTALL_DIR/previous" ] && [ -x "$INSTALL_DIR/previous/prism" ] || die "no previous version to go back to"
	from=$(readlink "$INSTALL_DIR/current")
	to=$(readlink "$INSTALL_DIR/previous")
	from_channel=$(read_channel "$INSTALL_DIR/channel")
	to_channel=$(read_channel "$INSTALL_DIR/previous-channel")
	switch_link current "$to"
	switch_link previous "$from"
	# The channel goes back with the release it came with.
	write_channel channel "$to_channel"
	write_channel previous-channel "$from_channel"
	say "now on prism $(current_version || echo '?') ($to_channel channel); run the same command again to undo"
}

main() {
	set -eu
	BASE_URL=${PRISM_BASE_URL:-https://prism.odelserver.space}
	INSTALL_DIR=${PRISM_INSTALL_DIR:-$HOME/.local/share/prism}
	# A relative directory is taken from where the command runs: the link in BIN_DIR needs an absolute target
	#.
	case $INSTALL_DIR in /*) ;; *) INSTALL_DIR=$PWD/$INSTALL_DIR ;; esac
	BIN_DIR=${PRISM_BIN_DIR:-$HOME/.local/bin}

	mode=install
	channel_option=""
	while [ $# -gt 0 ]; do
		case $1 in
		--uninstall | --update | --rollback | --check)
			[ "$mode" = install ] || die "only one of --update, --check, --rollback and --uninstall at a time"
			mode=${1#--}
			;;
		--channel)
			[ $# -ge 2 ] || die "--channel needs a value: stable or canary"
			channel_option=$2
			shift
			;;
		*) die "unknown option: $1 (--uninstall, --update, --rollback, --check, --channel stable|canary)" ;;
		esac
		shift
	done
	case $channel_option in
	"" | stable | canary) ;;
	*) die "unknown channel: $channel_option (stable or canary)" ;;
	esac
	case $mode in
	uninstall | rollback) [ -z "$channel_option" ] || die "--channel goes with an install, --update or --check" ;;
	esac

	case $mode in
	uninstall)
		lock_install
		remove_link
		remove_install_dir
		remove_menu_entry
		rm -f -- "$INSTALL_DIR.lock"
		say "removed $INSTALL_DIR and $BIN_DIR/prism; your config in ~/.prism is kept"
		return 0
		;;
	rollback)
		lock_install
		rollback
		return 0
		;;
	esac

	[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "only linux-x64 is supported"
	# The bundled Node is built against glibc.
	[ -e /lib64/ld-linux-x86-64.so.2 ] || die "glibc is required (musl systems such as Alpine are not supported)"
	for tool in curl tar gzip base64 od dd sort; do
		command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
	done
	command -v minisign >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1 ||
		die "minisign or openssl (3.0 or later) is required to check the signature"
	if [ "$mode" = install ] && [ -e "$BIN_DIR/prism" ] && [ ! -L "$BIN_DIR/prism" ]; then
		die "$BIN_DIR/prism exists and is not a link created by the Prism installer; remove it yourself"
	fi
	# Never adopt a directory the installer did not create: installing
	# prunes what its versions/ holds.
	if [ "$mode" = install ] && [ -e "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/$MARKER" ]; then
		die "$INSTALL_DIR exists but was not created by the Prism installer; remove it yourself"
	fi
	if [ "$mode" != install ]; then
		[ -f "$INSTALL_DIR/$MARKER" ] && [ -L "$INSTALL_DIR/current" ] ||
			die "no Prism installation in $INSTALL_DIR; install it with: curl -fsSL $BASE_URL/install.sh | sh"
	fi

	[ "$mode" = check ] || lock_install
	work=$(mktemp -d "${TMPDIR:-/tmp}/prism-install.XXXXXX")
	staging=""
	trap 'rm -rf -- "$work" ${staging:+"$staging"}' EXIT
	trap 'exit 1' INT TERM

	installed_channel=$(read_channel "$INSTALL_DIR/channel")
	channel=${channel_option:-$installed_channel}
	if [ -n "${PRISM_VERSION:-}" ]; then
		version=$PRISM_VERSION
	else
		if [ "$channel" = stable ]; then
			fetch "$BASE_URL/releases/LATEST" "$work/LATEST"
			version=$(head -n 1 "$work/LATEST")
		else
			# Canary follows the newer of the two lists: a stable release promoted after the
			# last canary reaches canary installations too. Either list may be missing.
			version=""
			for list in LATEST LATEST-canary; do
				curl -fsSL --proto '=https' --tlsv1.2 -o "$work/$list" "$BASE_URL/releases/$list" 2>/dev/null || continue
				listed=$(head -n 1 "$work/$list")
				valid_version "$listed" || die "invalid version: $listed"
				if [ -z "$version" ] || older_than "$version" "$listed"; then version=$listed; fi
			done
			[ -n "$version" ] ||
				die "cannot download $BASE_URL/releases/LATEST-canary: check the network connection, or try again later"
		fi
	fi
	valid_version "$version" || die "invalid version: $version"
	release_channel=$(version_channel "$version")
	# LATEST is not signed; the version name and the signed comment are what bind a release to a channel.
	if [ "$channel" = stable ] && [ "$release_channel" = canary ]; then
		die "$version is a canary release and this installation is on the stable channel; nothing was changed (--channel canary switches)"
	fi

	installed=$(current_version || true)
	# --check only reports, even when the installed prism cannot say its version.
	if [ "$mode" = check ] && [ -z "$installed" ]; then
		die "cannot tell which version is installed: $INSTALL_DIR/current/prism does not answer --version; $version is the latest $channel release; nothing was changed (reinstall with: curl -fsSL $BASE_URL/install.sh | sh)"
	fi
	switching=""
	[ "$channel" = "$installed_channel" ] || switching=1
	if [ "$mode" != install ] && [ -n "$installed" ]; then
		if [ "$installed" = "$version" ]; then
			if [ -n "$switching" ] && [ "$mode" = update ]; then
				# previous-channel stays the channel of the release previous points to: no release moved.
				write_channel channel "$channel"
				say "now on the $channel channel; prism $installed is its latest release"
				[ "$channel" = stable ] || canary_warning
			else
				say "prism $installed is up to date ($channel channel)"
			fi
			return 0
		fi
		# LATEST is not signed: refuse an older release unless one was asked for by name, or a
		# channel switch was asked for (canary to stable usually goes back).
		if older_than "$version" "$installed" && [ -z "${PRISM_VERSION:-}" ] && [ -z "$switching" ]; then
			die "the server offers $version, older than the installed $installed; nothing was changed"
		fi
		if [ "$mode" = check ]; then
			say "prism $version is available on the $channel channel (installed: $installed); run: prism update${switching:+ --channel $channel}"
			return 0
		fi
		if older_than "$version" "$installed"; then
			say "going back from $installed to $version, the latest $channel release; your config in ~/.prism is kept, settings that only $installed knows are ignored"
		fi
	fi

	archive="prism-$version-linux-x64.tar.gz"
	release="$BASE_URL/releases/$version"

	say "downloading prism $version"
	fetch "$release/SHA256SUMS" "$work/SHA256SUMS"
	fetch "$release/SHA256SUMS.minisig" "$work/SHA256SUMS.minisig"
	comment=$(verify_signature "$work/SHA256SUMS" "$work/SHA256SUMS.minisig" "$work" "$(release_key "$release_channel")") ||
		die "SHA256SUMS: bad signature, nothing was installed"
	# The trusted comment is signed: it binds SHA256SUMS to this version and its channel.
	expected_comment="prism $version"
	[ "$release_channel" = stable ] || expected_comment="prism $version canary"
	[ "$comment" = "$expected_comment" ] ||
		die "SHA256SUMS is signed for '$comment', not '$expected_comment'; nothing was installed"
	expected=$(awk -v f="$archive" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")
	[ -n "$expected" ] || die "$archive is not listed in SHA256SUMS"

	fetch "$release/$archive" "$work/$archive"
	[ "$(sha256 "$work/$archive")" = "$expected" ] || die "$archive: checksum mismatch, nothing was installed"
	# Release notes, covered by the signature like the archive; shown after an update.
	notes_sum=$(awk '$2 == "NOTES.md" || $2 == "*NOTES.md" { print $1 }' "$work/SHA256SUMS")
	if [ "$mode" = update ] && [ -n "$notes_sum" ]; then
		fetch "$release/NOTES.md" "$work/NOTES.md"
		[ "$(sha256 "$work/NOTES.md")" = "$notes_sum" ] || die "NOTES.md: checksum mismatch, nothing was installed"
	fi
	say "signature and checksum verified"

	mkdir -p "$work/release"
	tar -xzf "$work/$archive" -C "$work/release" --strip-components=1 || die "could not extract $archive"
	[ -f "$work/release/$MARKER" ] && [ -x "$work/release/prism" ] || die "$archive does not look like a Prism release"
	"$work/release/prism" --version >/dev/null 2>&1 || die "the downloaded prism does not start; nothing was installed"

	# An installation from before versions/ is replaced whole.
	if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/versions" ]; then
		remove_install_dir
	fi
	mkdir -p "$INSTALL_DIR/versions"
	: >"$INSTALL_DIR/$MARKER"
	# A unique name, so reinstalling the version in use never touches its files.
	name="$version-$(date +%Y%m%d%H%M%S)-$$"
	staging="$INSTALL_DIR/versions/$name"
	mv -- "$work/release" "$staging"

	before=$(readlink "$INSTALL_DIR/current" 2>/dev/null || true)
	switch_link current "versions/$name"
	staging=""
	[ -z "$before" ] || switch_link previous "$before"
	[ -z "$before" ] || write_channel previous-channel "$installed_channel"
	write_channel channel "$channel"
	prune_versions

	if [ "$mode" = install ]; then
		mkdir -p "$BIN_DIR"
		ln -sfn "$INSTALL_DIR/current/prism" "$BIN_DIR/prism"
		say "installed prism $version ($channel channel) in $INSTALL_DIR"
		say "command: $BIN_DIR/prism"
		case ":$PATH:" in
		*":$BIN_DIR:"*) ;;
		*) say "$BIN_DIR is not in your PATH; add it to run 'prism' directly" ;;
		esac
	else
		say "updated prism ${installed:-?} -> $version ($channel channel); 'prism update --rollback' goes back"
		if [ -f "$work/NOTES.md" ]; then
			printf '\n'
			cat "$work/NOTES.md"
		fi
	fi
	sandbox_program
	window_libraries
	[ "$mode" != install ] || desktop_libraries
	[ "$mode" != install ] || portal_libraries
	[ "$channel" = stable ] || canary_warning
}

main "$@"
