#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs the conformance suite's policy case: the real engine under an
# administrator's policy that limits threads to Supervised.
#
# T3 Code reads its policy only from /etc/t3code/policy.json, which applies to
# every T3 Code on the machine. So the file is written in a private mount
# namespace, on an overlay over /etc, and only the engine this run starts sees
# it; nothing outside the namespace changes. Needs sudo, and unshare and
# setpriv (util-linux). The suite itself runs as the calling user, with the
# same engine home as `test:conformance`.
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
    mkdir -p /etc/t3code
    printf "%s\n" \
      "{\"schemaVersion\":1,\"organization\":\"J3 Conformance\",\"limits\":{\"maxRuntimeMode\":\"approval-required\"}}" \
      > /etc/t3code/policy.json
    cd "$PACKAGE"
    exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups \
      env HOME="$RUN_HOME" PATH="$RUN_PATH" J3_CONFORMANCE_HOME="$J3_CONFORMANCE_HOME" \
      J3_CONFORMANCE_SUPERVISED_ONLY=1 \
      vp test run --config conformance/vite.config.ts --dir . -t "policy"
  '
