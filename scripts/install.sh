#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Installs J3 Bots from a GitHub release: the server archive for this machine,
# checked against the release's SHA256SUMS once its signature is checked, the
# j3-bots command, and the systemd user service. Needs sh, tar, curl or wget,
# sha256sum or shasum, and OpenSSL 3: no Node, Git or root. After T3 Code's
# scripts/install.sh.
#
#   curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/download/v0.1.0-rc.1/install.sh | sh -s -- --version 0.1.0-rc.1
#
# A release's tag is v<version>; a nightly's is its version alone, such as
# 0.3.1-nightly.20261124.57.
#
# Options:
#   --version <version>  install this release, a pre-release included
#                        (default: the latest release, never a pre-release)
#   --no-service         install the command only, not the service
#
# Environment:
#   J3_INSTALL_DIR       where releases are kept (default: $XDG_DATA_HOME/j3-bots,
#                        or ~/.local/share/j3-bots), outside the data directory
#   J3_BIN_DIR           where the j3-bots command goes (default: ~/.local/bin)
#   J3_HOME              the data directory (default: ~/.j3-bots)
#   J3_RELEASE_BASE_URL  the releases page, or a mirror of it that serves
#                        <base>/latest and <base>/download/<tag>/<file>
#                        (default: https://github.com/JPSAUD501/j3-bots/releases).
#                        Its SHA256SUMS must be signed like the release's, so a
#                        mirror of a release serves the release's own files.
#   J3_RELEASE_PUBLIC_KEY  with J3_RELEASE_BASE_URL only: the Ed25519 public key
#                        (PEM) the mirror's SHA256SUMS is signed with, taken as
#                        well as the release keys below. For tests, and for a
#                        mirror that builds and signs its own releases.
#
# What it installs (docs/decisions/0015-a-release-is-a-self-contained-archive.md):
#
#   $J3_INSTALL_DIR/versions/<version>/   one unpacked release archive
#   $J3_INSTALL_DIR/launcher              the path of the command below, which
#                                         marks the folder as an install
#   $J3_BIN_DIR/j3-bots                   runs one of those versions
#
# `j3-bots uninstall` removes those, and the service, and nothing else.
set -eu
# What it makes is its user's alone to change, whatever the shell's umask.
umask 022

base_url="${J3_RELEASE_BASE_URL:-https://github.com/JPSAUD501/j3-bots/releases}"
base_url="${base_url%/}"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\nj3-bots install: %s\n' "$*" >&2
  exit 1
}

usage() {
  say "Installs J3 Bots for this user."
  say ""
  say "  sh install.sh [--version <version>] [--no-service]"
  say ""
  say "  --version <version>  install this release, a pre-release included (default: the latest release)"
  say "  --no-service         install the command only, not the systemd user service"
}

version=
service=true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version needs a version, such as 0.1.0."
      version="$2"
      shift 2
      ;;
    --version=*)
      version="${1#--version=}"
      shift
      ;;
    --no-service)
      service=false
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "$1 is not an option this script takes. Run it with --help for the ones it does." ;;
  esac
done
version="${version#v}"
case "$version" in
  "") ;;
  [0-9]*[!0-9A-Za-z.-]* | [!0-9]*) fail "$version is not a version, such as 0.1.0 or 0.1.0-rc.1." ;;
esac

# --- This machine ------------------------------------------------------------

[ "$(id -u)" != 0 ] ||
  fail "Run this as the user J3 Bots will run as, not as root or with sudo: the service is that user's, and bots act as that user."

case "$(uname -s)" in
  Linux) ;;
  *) fail "J3 Bots runs on Linux with systemd; $(uname -s) is not supported." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "J3 Bots runs on x64 and arm64 Linux; $(uname -m) is not supported." ;;
esac

if command -v curl > /dev/null 2>&1; then
  downloader=curl
elif command -v wget > /dev/null 2>&1; then
  downloader=wget
else
  fail "curl or wget is needed to download J3 Bots. Install one of them, then run this again."
fi
command -v tar > /dev/null 2>&1 || fail "tar is needed to unpack J3 Bots. Install it, then run this again."
if command -v sha256sum > /dev/null 2>&1; then
  checksum() { sha256sum < "$1" | cut -d' ' -f1; }
elif command -v shasum > /dev/null 2>&1; then
  checksum() { shasum -a 256 < "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is needed to check the download. Install one of them, then run this again."
fi
# The release's SHA256SUMS is signed with Ed25519, which OpenSSL checks over a
# file's raw bytes from version 3 on (`pkeyutl -rawin`). LibreSSL, which also
# answers to `openssl`, is not OpenSSL 3.
command -v openssl > /dev/null 2>&1 ||
  fail "OpenSSL 3 is needed to check the release's signature. Install OpenSSL 3 (on Debian, Ubuntu or Raspberry Pi OS: \`sudo apt install openssl\`), then run this again."
openssl_version="$(openssl version 2> /dev/null || true)"
case "$openssl_version" in
  "OpenSSL "[3-9].* | "OpenSSL "[1-9][0-9]*.*) ;;
  *) fail "OpenSSL 3 or newer is needed to check the release's signature, and this machine has ${openssl_version:-an openssl that does not say its version}. Install OpenSSL 3 (Debian 12, Ubuntu 22.04 and Raspberry Pi OS bookworm ship it), then run this again." ;;
esac
if [ -n "${J3_RELEASE_PUBLIC_KEY:-}" ] && [ -z "${J3_RELEASE_BASE_URL:-}" ]; then
  fail "J3_RELEASE_PUBLIC_KEY names the key of a mirror, so it is taken only with J3_RELEASE_BASE_URL. Unset it to install from the release page."
fi

# The same question `j3-bots service install` asks, before anything is downloaded.
if "$service" && ! systemctl --user show-environment > /dev/null 2>&1; then
  fail "There is no systemd user manager to run the service in. Log in to a systemd session as this user (not with sudo or su), then run this again. Or run this with --no-service, and start the server yourself with \`j3-bots serve\`."
fi

# --- Where it goes -----------------------------------------------------------

# An absolute path with no trailing slash. The paths go into the command and the
# service's unit, which take no quotes, backslashes or control characters.
absolute() {
  case "$1" in
    /*) set -- "$1" ;;
    *) set -- "$PWD/$1" ;;
  esac
  while [ "${1%/}" != "$1" ] && [ "$1" != / ]; do set -- "${1%/}"; done
  case "$1" in
    *[\'\"\\]*) fail "$1 has a quote or a backslash in it. Choose a folder without them." ;;
  esac
  [ "$(printf '%sx' "$1" | tr -d '[:cntrl:]')" = "${1}x" ] ||
    fail "The folder $1 has a control character in it. Choose a folder without one."
  printf '%s' "$1"
}

install_dir="$(absolute "${J3_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/j3-bots}")"
bin_dir="$(absolute "${J3_BIN_DIR:-$HOME/.local/bin}")"
data_dir="$(absolute "${J3_HOME:-$HOME/.j3-bots}")"
case "$install_dir/" in
  "$data_dir"/*) fail "J3_INSTALL_DIR ($install_dir) is inside the data directory $data_dir, which the server keeps private. Choose a folder outside it." ;;
esac
versions_dir="$install_dir/versions"
launcher="$bin_dir/j3-bots"
record="$install_dir/launcher"

# The whole text of the command that runs the release at $1. Only a command
# that is exactly this is install.sh's, here and to `j3-bots uninstall`
# (apps/server/src/install/layout.ts, which has the same text).
launcher_text() {
  say '#!/bin/sh'
  say "# J3 Bots, installed by install.sh. \`j3-bots uninstall\` removes it."
  say "exec '$1/bin/j3-bots' \"\$@\""
}

# The version a command at $1 runs, when install.sh wrote it for this install;
# nothing for anything else, such as a link to a checkout or a wrapper.
installed_version() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(wc -l < "$1")" -eq 3 ] || return 0
  line="$(sed -n '3p' "$1")"
  found="${line#"exec '$versions_dir/"}"
  found="${found%"/bin/j3-bots' \"\$@\""}"
  case "$found" in "" | . | .. | */* | *"'"*) return 0 ;; esac
  # $(…) drops the last newlines; with three lines counted, equal text is equal bytes.
  [ "$(cat "$1")" = "$(launcher_text "$versions_dir/$found")" ] || return 0
  printf '%s' "$found"
}

# Refuses the folder $1 when another account could change what is in it: it
# must be this user's, and no account but this user may write to it. Its
# group may, when that is this user's own group, as a folder made under
# umask 002 lets it. What is in these folders runs as this user.
#
# Then every folder above it, up to /, both on the path as given and on the
# one its links lead to: another account that may write to one could move
# what it holds away, $1 with it, and put a folder of its own there. Each
# must be this user's or root's, and written by no other account, unless it
# is sticky, as /tmp is, where only the owner of what it holds may move that.
private_folder() {
  [ -n "$(find -H "$1" -prune -user "$(id -u)")" ] ||
    fail "$1 belongs to another account, which could change what runs from it. Choose a folder of your own, such as one under $HOME."
  [ -n "$(find -H "$1" -prune ! -perm -o+w)" ] ||
    fail "$1 can be written by every account, which could change what runs from it. Take that away with \`chmod o-w $1\`, then run this again."
  [ -n "$(find -H "$1" -prune \( ! -perm -g+w -o -group "$(id -g)" \))" ] ||
    fail "$1 can be written by its group, which is not this user's own, so other accounts could change what runs from it. Take that away with \`chmod g-w $1\`, then run this again."
  private_parents "$1" "$1"
  resolved="$(cd -P -- "$1" && pwd -P)" || fail "Could not open $1 to see where it leads. Check that this user may open it, then run this again."
  private_parents "$resolved" "$1"
}

# Checks every folder above $1 as private_folder says; $2 is the folder they
# lead to, for the message.
private_parents() {
  above="$1"
  while [ "$above" != / ]; do
    above="${above%/*}"
    [ -n "$above" ] || above=/
    [ -n "$(find -H "$above" -prune \( -user "$(id -u)" -o -user 0 \))" ] ||
      fail "$above, a folder $2 is in, belongs to another account, which could move $2 away and put a folder of its own in its place. Choose a folder of your own, such as one under $HOME."
    # Sticky: only the owner of a folder in it may move that folder.
    [ -z "$(find -H "$above" -prune -perm -1000)" ] || continue
    [ -n "$(find -H "$above" -prune ! -perm -o+w)" ] ||
      fail "$above, a folder $2 is in, can be written by every account, which could move $2 away and put a folder of its own in its place. Take that away with \`chmod o-w $above\`, or choose another folder, then run this again."
    [ -n "$(find -H "$above" -prune \( ! -perm -g+w -o -group "$(id -g)" \))" ] ||
      fail "$above, a folder $2 is in, can be written by its group, which is not this user's own, so another account could move $2 away and put a folder of its own in its place. Take that away with \`chmod g-w $above\`, or choose another folder, then run this again."
  done
}

recorded=
if [ -f "$record" ]; then recorded="$(cat "$record")"; fi
if [ -n "$recorded" ] && [ "$recorded" != "$launcher" ] && [ -n "$(installed_version "$recorded")" ]; then
  fail "J3 Bots is installed in $install_dir with its command at $recorded. Remove it first with \`j3-bots uninstall\` (your data is kept), then run this again."
fi
current=
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  current="$(installed_version "$launcher")"
  [ -n "$current" ] ||
    fail "$launcher exists and this script did not write it, such as a link to a checkout. Move it away, then run this again."
fi

# --- Which release -----------------------------------------------------------

work="$(mktemp -d)"
staging=
trap 'rm -rf "$work" ${staging:+"$staging"}' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Fetches a small file whole: fetch <url> <file> [accept].
fetch() {
  if [ "$downloader" = curl ]; then
    curl -fsSL --retry 3 --retry-delay 2 -H "Accept: ${3:-*/*}" -o "$2" "$1"
  else
    wget -q --tries=3 --header="Accept: ${3:-*/*}" -O "$2" "$1"
  fi
}

# The public keys a release's SHA256SUMS may be signed with, one PEM block each:
# release-keys/*.pem, the same text (scripts/release-keys.test.ts checks it).
# A signature is good when any of them verifies it.
release_keys() {
  cat << 'KEYS'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnL4CWfO6teDA5jgo0VoeOOnrxy5a7R3y0DNeJeCRDfg=
-----END PUBLIC KEY-----
KEYS
}

# Whether <sums> is signed by one of the release's keys (or the mirror's), with
# the signature in <signature>: one line of base64, the 64 bytes of an Ed25519
# signature over the file's exact bytes. verify_signature <sums> <signature>.
verify_signature() {
  [ "$(wc -l < "$2")" -eq 1 ] && [ "$(wc -c < "$2")" -eq 89 ] &&
    grep -Eq '^[A-Za-z0-9+/]{86}==$' "$2" || return 1
  openssl base64 -d -A -in "$2" -out "$work/signature" 2> /dev/null || return 1
  rm -f "$work"/key-*.pem
  {
    release_keys
    if [ -n "${J3_RELEASE_PUBLIC_KEY:-}" ]; then printf '%s\n' "$J3_RELEASE_PUBLIC_KEY"; fi
  } | awk -v dir="$work" '
    /^-----BEGIN PUBLIC KEY-----$/ { n++; inside = 1 }
    inside { print > (dir "/key-" n ".pem") }
    /^-----END PUBLIC KEY-----$/ { inside = 0 }'
  for key in "$work"/key-*.pem; do
    [ -f "$key" ] || continue
    if openssl pkeyutl -verify -pubin -inkey "$key" -rawin -in "$1" -sigfile "$work/signature" > /dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# Downloads <url> into <file>, with a progress bar on a terminal.
download() {
  if [ "$downloader" = curl ]; then
    progress=-sS
    if [ -t 2 ]; then progress=--progress-bar; fi
    curl -fL "$progress" --retry 3 --retry-delay 2 -o "$2" "$1"
  else
    progress=-q
    if [ -t 2 ]; then progress=--progress=bar; fi
    wget "$progress" --tries=3 -O "$2" "$1"
  fi
}

if [ -z "$version" ]; then
  # GitHub's page of the latest release, not its API: no quota, and it is never
  # a pre-release or a draft. Asked for JSON, it answers {"tag_name":"v1.2.3",…}.
  fetch "$base_url/latest" "$work/latest" application/json ||
    fail "Could not read the latest release from $base_url/latest. If no release is published yet, name one with --version."
  version="$(sed -n 's/.*"tag_name": *"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$work/latest" | head -n 1)"
  [ -n "$version" ] ||
    fail "The latest release at $base_url/latest is not a stable version. Name the one to install with --version."
fi

if [ -n "$current" ] && [ "$current" != "$version" ]; then
  fail "J3 Bots $current is installed in $install_dir. This script installs only where none is, or the same version again. To move to $version, run \`j3-bots update --version $version\`."
fi

# --- The release -------------------------------------------------------------

stem="j3-bots-$version-linux-$arch"
archive="$stem.tar.gz"
target="$versions_dir/$version"
case "$version" in
  *-nightly.*) tag="$version" ;;
  *) tag="v$version" ;;
esac
download_url="$base_url/download/$tag"

# Before anything in them is used: a release already there is run as it is.
# A folder made below is checked once it is made.
for folder in "$install_dir" "$versions_dir" "$bin_dir"; do
  if [ -e "$folder" ]; then private_folder "$folder"; fi
done
# A release reaches versions/ only by the move below, from a checked download,
# so anything else there is not this script's, and stays as it is.
if [ -f "$target/release.json" ] && [ -x "$target/bin/j3-bots" ]; then
  say "J3 Bots $version is already in $target."
elif [ -e "$target" ] || [ -L "$target" ]; then
  fail "$target is there, but it is not a J3 Bots release: it has no release.json or no bin/j3-bots. If it is yours, move it away; if it is a damaged J3 Bots release, delete it. Then run this again. Nothing was changed."
else
  say "Installing J3 Bots $version for linux-$arch."
  fetch "$download_url/SHA256SUMS" "$work/SHA256SUMS" ||
    fail "Could not download $download_url/SHA256SUMS. Check the version (a pre-release by its full name, such as 0.1.0-rc.1) and the network."
  # The signature first: nothing in SHA256SUMS is read until it is checked.
  fetch "$download_url/SHA256SUMS.sig" "$work/SHA256SUMS.sig" ||
    fail "Could not download $download_url/SHA256SUMS.sig, the signature that shows the release is J3 Bots', so nothing was installed. Releases before 0.3.1 have none: install one of those with the install.sh on its own release page. Otherwise check the network, then run this again."
  key_name="the J3 Bots release key"
  if [ -n "${J3_RELEASE_PUBLIC_KEY:-}" ]; then key_name="the J3 Bots release key or the mirror's key in J3_RELEASE_PUBLIC_KEY"; fi
  verify_signature "$work/SHA256SUMS" "$work/SHA256SUMS.sig" ||
    fail "The signature on J3 Bots $version's SHA256SUMS does not match $key_name, so nothing was installed: these are not the files that were published. Run this again; if it happens again, the download is being changed on the way."
  expected="$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1; exit }' "$work/SHA256SUMS")"
  [ -n "$expected" ] || fail "J3 Bots $version has no archive for linux-$arch."

  download "$download_url/$archive" "$work/$archive" ||
    fail "Could not download $download_url/$archive. Check the network, then run this again."
  [ "$(checksum "$work/$archive")" = "$expected" ] ||
    fail "$archive does not match its checksum in SHA256SUMS, so nothing was installed. Run this again; if it happens again, the download is being changed on the way."

  # Unpacked beside the versions, so the move into place is a rename.
  mkdir -p "$versions_dir"
  private_folder "$install_dir"
  private_folder "$versions_dir"
  staging="$(mktemp -d "$versions_dir/.staging-XXXXXX")"
  tar -xzf "$work/$archive" -C "$staging" || fail "Could not unpack $archive."
  [ -f "$staging/$stem/release.json" ] || fail "$archive is not a J3 Bots release: it has no $stem/release.json."
  "$staging/$stem/bin/j3-bots" --version > /dev/null ||
    fail "J3 Bots $version does not run on this machine; nothing was installed."
  mv "$staging/$stem" "$target"
  rm -rf "$staging"
  staging=
fi

# --- The command -------------------------------------------------------------

mkdir -p "$bin_dir"
private_folder "$bin_dir"
# The record first: whenever the command exists, `j3-bots uninstall` finds it.
printf '%s\n' "$launcher" > "$work/launcher"
mv -f "$work/launcher" "$record"
next="$(mktemp "$bin_dir/.j3-bots.XXXXXX")"
launcher_text "$target" > "$next"
chmod 755 "$next"
mv -f "$next" "$launcher"

# --- Checks and the service --------------------------------------------------

say ""
say "Checking this machine (j3-bots doctor):"
say ""
# doctor exits with 1 while anything is missing, which on a new install is
# usually only a provider; its report is what this step is for.
"$launcher" doctor || true

if "$service"; then
  say ""
  "$launcher" service install ||
    fail "J3 Bots $version is installed, but the service did not start: see above. Fix what it says, then run \`j3-bots service install\`."
fi

# --- What next ---------------------------------------------------------------

command_name="$launcher"
case ":$PATH:" in
  *":$bin_dir:"* | *":$bin_dir/:"*)
    if [ "$(command -v j3-bots 2> /dev/null || true)" = "$launcher" ]; then command_name=j3-bots; fi
    ;;
esac

say ""
say "J3 Bots $version is installed: $launcher"
if [ "$command_name" = "$launcher" ]; then
  say "$bin_dir is not first on your PATH for j3-bots; run it as $launcher, or add $bin_dir to your PATH."
fi
say ""
say "Next:"
step=1
if ! "$service"; then
  say "  $step. Start the server: \`$command_name serve\`, or install the service with \`$command_name service install\`."
  step=$((step + 1))
fi
say "  $step. Give bots a way to their models: \`$command_name provider connect\` for an endpoint in front of your subscriptions,"
say "     or \`$command_name provider login claude-code\` and \`$command_name provider login codex --device-auth\` to sign each one in."
step=$((step + 1))
say "  $step. Pair a browser or an app: \`$command_name pair\`."
