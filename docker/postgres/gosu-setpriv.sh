#!/bin/sh
# HeoPress replacement for /usr/local/bin/gosu in the database image.
#
# The upstream postgres image ships gosu, a Go binary whose compiled-in Go
# standard library carries advisories that are fixed only when the official
# image is rebuilt. Its only job here is the official docker-entrypoint.sh
# dropping from root to the postgres user:
#
#   exec gosu postgres "$BASH_SOURCE" "$@"
#
# This shim does the same with setpriv (util-linux, part of the Debian base):
# real, effective and saved uid/gid are set to the target user, supplementary
# groups are the target user's (or none when the uid has no passwd entry),
# and HOME is set to the user's home directory, as gosu does. It then execs
# the command, so the server keeps the shim's PID (PID 1 in the container).
#
#   gosu user-spec command [args...]
#   user-spec: user | user:group | uid | uid:gid (names or numbers)
set -eu

usage() {
	echo "usage: gosu user-spec command [args]" >&2
	echo "   eg: gosu postgres bash" >&2
	echo "       gosu postgres:postgres bash" >&2
	echo "       gosu 999:999 bash" >&2
	echo "(HeoPress: setpriv-based replacement for gosu)" >&2
}

case "${1:-}" in
	--help | -h) usage; exit 0 ;;
	--version | -v) echo "heopress-gosu-setpriv (util-linux setpriv)"; exit 0 ;;
esac
if [ "$#" -lt 2 ]; then usage; exit 1; fi

spec=$1
shift
user=${spec%%:*}
case $spec in
	*:*) group=${spec#*:} ;;
	*) group= ;;
esac
if [ -z "$user" ]; then echo "gosu: empty user in '$spec'" >&2; exit 1; fi

groups_opt=--clear-groups
if pw=$(getent passwd "$user"); then
	uid=$(printf '%s\n' "$pw" | cut -d: -f3)
	gid=$(printf '%s\n' "$pw" | cut -d: -f4)
	home=$(printf '%s\n' "$pw" | cut -d: -f6)
	groups_opt=--init-groups
else
	case $user in
		*[!0-9]*) echo "gosu: unknown user '$user'" >&2; exit 1 ;;
	esac
	# A uid without a passwd entry: no supplementary groups, the caller's gid, HOME=/ (as gosu).
	uid=$user
	gid=$(id -g)
	home=/
fi

if [ -n "$group" ]; then
	if gr=$(getent group "$group"); then
		gid=$(printf '%s\n' "$gr" | cut -d: -f3)
	else
		case $group in
			*[!0-9]*) echo "gosu: unknown group '$group'" >&2; exit 1 ;;
		esac
		gid=$group
	fi
fi

HOME=${home:-/}
export HOME
exec setpriv --reuid="$uid" --regid="$gid" "$groups_opt" -- "$@"
