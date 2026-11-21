#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fails when a commit in <base>..<head> is not signed off by its author: its
# message has no `Signed-off-by:` trailer with the author's e-mail address
# (CONTRIBUTING.md). Merge commits are not checked. Run it inside the
# repository:
#
#   scripts/check-signoff.sh <base> <head>
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: scripts/check-signoff.sh <base> <head>" >&2
  exit 2
fi
# A range git cannot read would list no commits, and pass.
for ref in "$1" "$2"; do
  if ! git rev-parse --quiet --verify "$ref^{commit}" >/dev/null; then
    echo "Not a commit in this repository: $ref" >&2
    exit 2
  fi
done

commits=$(git rev-list --no-merges "$1..$2")
unsigned=0
for commit in $commits; do
  author=$(git show -s --format=%ae "$commit")
  if ! git show -s --format='%(trailers:key=Signed-off-by,valueonly)' "$commit" |
    grep -qiF "<$author>"; then
    echo "Not signed off by its author, $author: $(git show -s --format='%h %s' "$commit")" >&2
    unsigned=1
  fi
done

if [[ $unsigned -ne 0 ]]; then
  echo "Sign every commit off with \`git commit -s\`. To sign off commits already made, run \`git rebase --signoff\` onto the branch the pull request targets, then push with --force-with-lease (CONTRIBUTING.md)." >&2
fi
exit "$unsigned"
