#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The version of a nightly build: a pre-release of the patch after the latest
# stable release, named for its day (UTC) and the nightly workflow's run
# (docs/decisions/0031-a-release-is-signed-and-a-nightly-is-a-pre-release-of-the-next-patch.md).
#
#   scripts/nightly-version.sh <stable version> <YYYYMMDD> <run number>
#   scripts/nightly-version.sh 0.3.0 20261124 57    prints 0.3.1-nightly.20261124.57
#
# The release workflow's `draft` job checks the version it makes against what
# the Android app can number, as it checks a tag's.
set -euo pipefail

fail() {
  echo "nightly-version: $*" >&2
  exit 1
}

[[ "$#" -eq 3 ]] || fail "takes the latest stable version, the day as YYYYMMDD and the run number."
stable="$1" day="$2" run="$3"
number='(0|[1-9][0-9]{0,3})'
[[ "$stable" =~ ^$number\.$number\.$number$ ]] ||
  fail "$stable is not a stable version, x.y.z."
major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
[[ "$day" =~ ^[0-9]{8}$ ]] || fail "$day is not a day as YYYYMMDD."
[[ "$run" =~ ^[1-9][0-9]{0,8}$ ]] || fail "$run is not a run number."
echo "$major.$minor.$((patch + 1))-nightly.$day.$run"
