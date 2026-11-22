#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs the conformance suite's policy case: the real engine under an
# administrator's policy that limits threads to Supervised.
#
# T3 Code reads its policy only from /etc/t3code/policy.json, which applies to
# every T3 Code on the machine. So the file is written in a private mount
# namespace, and only the engine this run starts sees it; nothing outside the
# namespace changes. There /etc is an overlay, and /etc/t3code a fresh, empty
# memory file system mounted on a folder made in that overlay, so a path the
# machine's own /etc/t3code holds, a symbolic link to elsewhere included, is
# never followed: the fixture is written as a new file there, refused if
# anything is in its place. The policy's folder and file belong to the calling
# user, as no administrator's would, so a case can take the policy away and
# put it back between two starts of the engine (`J3_CONFORMANCE_POLICY_FILE`);
# the engine reads the file whoever owns it.
# Needs sudo, and unshare and setpriv (util-linux). The suite itself runs as
# the calling user, with the same engine home as `test:conformance`.
set -euo pipefail

package="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
# The overlay's upper directory holds files root wrote.
trap 'sudo rm -rf -- "$scratch"' EXIT

sudo env \
  PACKAGE="$package" \
  SCRATCH="$scratch" \
  RUN_UID="$(id -u)" \
  RUN_GID="$(id -g)" \
  RUN_HOME="$HOME" \
  RUN_PATH="$PATH" \
  J3_CONFORMANCE_HOME="${J3_CONFORMANCE_HOME:-$HOME/.cache/j3-conformance}" \
  unshare --mount --propagation private bash -euo pipefail -c '
    mkdir -p "$SCRATCH/upper" "$SCRATCH/work"
    mount -t overlay overlay \
      -o "lowerdir=/etc,upperdir=$SCRATCH/upper,workdir=$SCRATCH/work" /etc
    # Removed in the overlay only: a symbolic link goes, never what it names.
    rm -rf --one-file-system /etc/t3code
    mkdir /etc/t3code
    mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /etc/t3code
    policy=/etc/t3code/policy.json
    if [ -e "$policy" ] || [ -L "$policy" ]; then
      echo "with-policy: $policy exists in a fresh mount" >&2
      exit 1
    fi
    # noclobber opens it with O_EXCL, which never follows a link.
    set -o noclobber
    printf "%s\n" \
      "{\"schemaVersion\":1,\"organization\":\"J3 Conformance\",\"limits\":{\"maxRuntimeMode\":\"approval-required\"}}" \
      > "$policy"
    set +o noclobber
    chown "$RUN_UID:$RUN_GID" /etc/t3code "$policy"
    cd "$PACKAGE"
    exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups \
      env HOME="$RUN_HOME" PATH="$RUN_PATH" J3_CONFORMANCE_HOME="$J3_CONFORMANCE_HOME" \
      J3_CONFORMANCE_SUPERVISED_ONLY=1 J3_CONFORMANCE_POLICY_FILE=/etc/t3code/policy.json \
      vp test run --config conformance/vite.config.ts --dir . -t "policy"
  '
