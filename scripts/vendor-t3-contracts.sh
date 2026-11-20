#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Replaces packages/engine-t3/vendor/t3-contracts with T3 Code's packages/contracts
# at the engine commit recorded in engine.json.
#
# To move the engine pin: edit engine.json (version and commit), run this script,
# then make the workspace typecheck and the conformance suite pass.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0   (reads the version and commit from engine.json)" >&2
  exit 2
fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="https://github.com/pingdotgg/t3code.git"
destination="$root/packages/engine-t3/vendor/t3-contracts"

read_pin() {
  node -e 'const pin = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(pin[process.argv[2]] ?? ""));' \
    "$root/engine.json" "$1"
}
version="$(read_pin version)"
commit="$(read_pin commit)"

if [[ -z $version || ! $commit =~ ^[0-9a-f]{40}$ ]]; then
  echo "engine.json must have a version and a full 40-character commit SHA" >&2
  exit 1
fi

# The pin names a release. Its tag must point at the recorded commit, so the
# vendored schemas are the ones the released binary was built from.
tag_commit="$(
  git ls-remote "$upstream" "refs/tags/v$version" "refs/tags/v$version^{}" |
    sort -k2 | tail -n 1 | cut -f1
)"
if [[ $tag_commit != "$commit" ]]; then
  echo "Tag v$version points at '${tag_commit:-nothing}', not $commit from engine.json" >&2
  exit 1
fi

scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

git init --quiet "$scratch/upstream"
git -C "$scratch/upstream" fetch --quiet --depth=1 --filter=blob:none "$upstream" "$commit"

mkdir -p "$scratch/out"
git -C "$scratch/upstream" archive FETCH_HEAD LICENSE packages/contracts/package.json packages/contracts/src |
  tar -x -C "$scratch/out"
mkdir -p "$scratch/vendor"
mv "$scratch/out/LICENSE" "$scratch/vendor/LICENSE"
mv "$scratch/out/packages/contracts/src" "$scratch/vendor/src"
# Upstream tests need T3 Code's own test setup; the conformance suite covers the
# schemas J3 Bots relies on.
find "$scratch/vendor/src" -type f -name '*.test.ts' -delete

# A workspace package under its upstream name and exports, so the adapter
# imports it as T3 Code's own code does, and so it typechecks on its own with
# J3 Bots' compiler settings and Effect version.
node - "$scratch/out/packages/contracts/package.json" "$scratch/vendor/package.json" "$commit" <<'EOF'
const fs = require("node:fs");
const [from, to, commit] = process.argv.slice(2);
const upstream = JSON.parse(fs.readFileSync(from, "utf8"));
const vendored = {
  name: upstream.name,
  version: `0.0.0-${commit.slice(0, 12)}`,
  private: true,
  license: "MIT",
  type: upstream.type,
  exports: upstream.exports,
  scripts: { typecheck: "effect-tsgo tsrs --noEmit" },
  dependencies: upstream.dependencies,
};
fs.writeFileSync(to, `${JSON.stringify(vendored, null, 2)}\n`);
EOF
cat >"$scratch/vendor/tsconfig.json" <<'EOF'
{
  "extends": "../../../../tsconfig.base.json",
  "include": ["src"]
}
EOF

cat >"$scratch/vendor/README.md" <<EOF
# T3 Code contracts (vendored)

\`packages/contracts/src\` of [T3 Code](https://github.com/pingdotgg/t3code) at
commit \`$commit\` (release \`v$version\`), the engine pin in \`engine.json\`.
Copyright (c) T3 Tools Inc., MIT license: see [LICENSE](LICENSE).

\`src\` is unchanged. \`package.json\` keeps the upstream name, exports and
dependencies; \`tsconfig.json\` is J3 Bots' own. Upstream tests are left out.

Do not edit these files. Change \`engine.json\` and run
\`scripts/vendor-t3-contracts.sh\` instead.
EOF

rm -rf -- "$destination"
mkdir -p -- "$(dirname -- "$destination")"
mv -- "$scratch/vendor" "$destination"
echo "Vendored T3 Code contracts v$version ($commit)"
