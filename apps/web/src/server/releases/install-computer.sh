#!/bin/sh
# Installs the hm-computer client on Linux and macOS.
#
#   curl -fsSL <origin>/install-computer.sh | sh
#   curl -fsSL <origin>/install-computer.sh | sh -s -- --code <code>
#
# Every step is a function and the last line runs main, so a download cut off
# part way through cannot run half of the script.

set -eu

HM_ORIGIN="@@HM_ORIGIN@@"
PRODUCT="hm-computer"
BIN_DIR="${HOME:?HOME is not set}/.local/bin"
BIN="$BIN_DIR/$PRODUCT"
CONFIG="$HOME/.hm/config.json"

# Set by the steps below and read by the ones after them.
CODE=""
TMP_BIN=""
OS_NAME=""
MACHINE_NAME=""
GOOS=""
GOARCH=""
FILE=""
VERSION=""
EXPECTED_SHA=""
ACTUAL_SHA=""
digest=""
manifest=""
manifest_url=""

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-computer.sh [--code <code>] [-h|--help]

Installs the hm-computer client to $HOME/.local/bin/hm-computer.

Options:
  --code <code>  Enrol this machine with a code from Settings > Machines.
  -h, --help     Show this help.
EOF
}

cleanup() {
  if [ -n "$TMP_BIN" ]; then
    rm -f "$TMP_BIN"
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --code)
        if [ "$#" -lt 2 ] || [ -z "$2" ]; then
          die "--code needs a code"
        fi
        CODE="$2"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1 (see --help)"
        ;;
    esac
  done
}

check_platform() {
  OS_NAME=$(uname -s)
  MACHINE_NAME=$(uname -m)
  case "$OS_NAME" in
    Linux) GOOS=linux ;;
    Darwin) GOOS=darwin ;;
    *) die "hm-computer supports Linux and macOS only, and this machine is $OS_NAME $MACHINE_NAME." ;;
  esac
  case "$MACHINE_NAME" in
    x86_64 | amd64) GOARCH=amd64 ;;
    aarch64 | arm64) GOARCH=arm64 ;;
    *) die "hm-computer supports amd64 and arm64 only, and this machine is $OS_NAME $MACHINE_NAME." ;;
  esac
  FILE="${PRODUCT}_${GOOS}_${GOARCH}"
}

read_manifest() {
  manifest_url="$HM_ORIGIN/releases/$PRODUCT/latest.json"
  if ! manifest=$(curl -fsSL "$manifest_url"); then
    die "could not download $manifest_url"
  fi
  VERSION=$(printf '%s\n' "$manifest" | sed -n 's/^  "version": "\([^"]*\)".*/\1/p' | head -n 1)
  EXPECTED_SHA=$(printf '%s\n' "$manifest" | awk -v name="$FILE" '
    index($0, "\"" name "\": {") && match($0, /"sha256": "[0-9a-f]+"/) {
      print substr($0, RSTART + 11, RLENGTH - 12)
      exit
    }')
  if [ -z "$VERSION" ]; then
    die "$manifest_url has no version"
  fi
  if [ -z "$EXPECTED_SHA" ]; then
    die "$manifest_url has no checksum for $FILE"
  fi
}

# Sets ACTUAL_SHA. It must not run in a $(...), because die would only end that subshell.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum "$1") || die "could not hash $1"
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 "$1") || die "could not hash $1"
  else
    die "need sha256sum or shasum to check the download"
  fi
  ACTUAL_SHA=$(printf '%s\n' "$digest" | awk '{ print $1 }')
}

install_binary() {
  url="$HM_ORIGIN/releases/$PRODUCT/$VERSION/$FILE"
  mkdir -p "$BIN_DIR"
  TMP_BIN=$(mktemp "$BIN_DIR/.$PRODUCT.XXXXXX") || die "could not create a temporary file in $BIN_DIR"
  say "Downloading $PRODUCT $VERSION ($FILE)"
  if ! curl -fL --progress-bar -o "$TMP_BIN" "$url"; then
    die "could not download $url"
  fi
  sha256_of "$TMP_BIN"
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    die "checksum mismatch for $FILE: expected $EXPECTED_SHA, got $ACTUAL_SHA. Nothing was installed."
  fi
  chmod 755 "$TMP_BIN"
  if ! mv -f "$TMP_BIN" "$BIN"; then
    die "could not move the binary to $BIN"
  fi
  TMP_BIN=""
  say "Installed $BIN"
}

check_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      say "$BIN_DIR is not on your PATH. Add this line to your shell profile (~/.profile or ~/.zshrc):"
      say '  export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac
}

enroll_machine() {
  if ! "$BIN" enroll --url "$HM_ORIGIN" --code "$CODE" </dev/null; then
    die "enrolment failed (see the message above). Get a new code from Settings > Machines."
  fi
  say "Start the client with: $BIN run"
}

next_step() {
  if [ -f "$CONFIG" ]; then
    say "This machine is already enrolled, so the existing enrolment is kept."
    say "Restart hm-computer to load the new version. Run it with: $BIN run"
    return 0
  fi
  say "Next, enrol this machine with a code from Settings > Machines:"
  say "  $BIN enroll --url $HM_ORIGIN --code <code>"
}

print_version() {
  if ! "$BIN" version </dev/null; then
    die "$BIN version failed"
  fi
}

main() {
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  parse_args "$@"
  check_platform
  read_manifest
  install_binary
  check_path
  if [ -n "$CODE" ]; then
    enroll_machine
  else
    next_step
  fi
  print_version
}

main "$@"
