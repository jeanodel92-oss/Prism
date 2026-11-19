#!/bin/sh
# A stand-in prism-remote for the scenario qa-settings-linked-phones (drive-all.sh): it lists the linked phones kept
# in the file PRISM_REMOTE_DOUBLE_STATE, one fingerprint per line, and revokes them. Nothing else of prism-remote.
state="${PRISM_REMOTE_DOUBLE_STATE:?}"
case "$1" in
devices) cat "$state" ;;
revoke)
	grep -qx "$2" "$state" || { echo "$2 is not a paired device" >&2; exit 1; }
	grep -vx "$2" "$state" >"$state.new"
	mv "$state.new" "$state"
	echo "revoked $2"
	;;
*) echo "prism-remote double: unknown command $1" >&2; exit 2 ;;
esac
