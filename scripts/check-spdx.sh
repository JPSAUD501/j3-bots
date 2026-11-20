#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fails when a first-party source file has no SPDX license identifier (ADR 0008).
# Vendored upstream source keeps its own license and is not checked.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
missing=0
while IFS= read -r -d '' file; do
  [[ -f "$root/$file" ]] || continue
  if ! head -n 3 -- "$root/$file" | grep -q "SPDX-License-Identifier: AGPL-3.0-or-later"; then
    echo "Missing SPDX identifier: $file" >&2
    missing=1
  fi
done < <(
  git -C "$root" ls-files -z --cached --others --exclude-standard -- \
    '*.ts' '*.tsx' '*.mts' '*.js' '*.mjs' '*.sh' ':!:packages/engine-t3/vendor/**'
)
exit "$missing"
