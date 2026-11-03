#!/bin/sh
# Installs the agentum machine daemon on Linux.
#
#   curl -fsSL <origin>/install.sh | sh
#   curl -fsSL <origin>/install.sh | sh -s -- --code <code>
#
# Every step is a function and the last line runs main, so a download cut off
# part way through cannot run half of the script.

set -eu

HM_ORIGIN="@@HM_ORIGIN@@"
PRODUCT="agentum"
SERVICE="agentum"
BIN_DIR="${HOME:?HOME is not set}/.local/bin"
BIN="$BIN_DIR/$PRODUCT"
CONFIG="$HOME/.agentum/config.json"
# An install from before the rename to Agentum. The daemon still reads its
# config, and install-service replaces its unit with the agentum one.
LEGACY_NAME="harbourmaster"
LEGACY_CONFIG="$HOME/.$LEGACY_NAME/config.json"

# Set by the steps below and read by the ones after them.
CODE=""
NO_SERVICE=0
TMP_BIN=""
OS_NAME=""
MACHINE_NAME=""
FILE=""
VERSION=""
EXPECTED_SHA=""
ACTUAL_SHA=""
ARCH=""
url=""
digest=""
manifest=""
manifest_url=""
rc=0
version_text=""

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--code <code>] [--no-service] [-h|--help]

Installs the agentum daemon to $HOME/.local/bin/agentum.

Options:
  --code <code>  Enrol this machine with a code from Settings > Machines.
  --no-service   Skip the systemd user service.
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
      --no-service)
        NO_SERVICE=1
        shift
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
  case "$MACHINE_NAME" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) ARCH="" ;;
  esac
  if [ "$OS_NAME" != "Linux" ] || [ -z "$ARCH" ]; then
    die "agentum supports Linux x64 and arm64 only, and this machine is $OS_NAME $MACHINE_NAME."
  fi
  FILE="$PRODUCT-linux-$ARCH"
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
      say "$BIN_DIR is not on your PATH. Add this line to your shell profile (~/.profile or ~/.bashrc):"
      say '  export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac
}

check_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "Claude Code was not found on your PATH. The daemon needs Claude Code, so install it before you start the daemon."
  fi
}

has_systemd() {
  [ -d "${HM_SYSTEMD_RUN_DIR:-/run/systemd/system}" ] && command -v systemctl >/dev/null 2>&1
}

# Runs `install-service` with the given options. It writes the unit for this
# binary, enables it and, on an enrolled machine, restarts it. Exit 2 means
# lingering is off.
run_install_service() {
  rc=0
  "$BIN" install-service "$@" </dev/null || rc=$?
  case "$rc" in
    0)
      say "The agentum systemd user service now runs $BIN."
      ;;
    2)
      warn "the service is installed, but lingering is off, so it stops when you log out."
      warn "Enable lingering with: loginctl enable-linger $(id -un) (this may need sudo)"
      ;;
    *)
      die "$BIN install-service failed with exit code $rc (see the message above). A fresh install can skip the service with --no-service."
      ;;
  esac
}

# The unit file is checked too, because `systemctl --user` fails when the user
# bus is out of reach (under `su -`, say) though the unit is there.
unit_installed() {
  [ -f "$HOME/.config/systemd/user/$1.service" ] ||
    systemctl --user cat "$1" >/dev/null 2>&1 </dev/null
}

service_installed() {
  unit_installed "$SERVICE" || unit_installed "$LEGACY_NAME"
}

setup_service() {
  if [ "$NO_SERVICE" -eq 1 ]; then
    say "Skipped the service (--no-service)."
    return 0
  fi
  if ! has_systemd; then
    say "systemd was not found, so no service was installed. Once the machine is enrolled, run the daemon by hand: $BIN run"
    return 0
  fi
  run_install_service
}

enroll_machine() {
  if [ -z "$CODE" ]; then
    say "Next, enrol this machine with a code from Settings > Machines:"
    say "  $BIN enroll <code> --server $HM_ORIGIN"
    return 0
  fi
  if ! "$BIN" enroll "$CODE" --server "$HM_ORIGIN" </dev/null; then
    die "enrolment failed (see the message above). Get a new code from Settings > Machines."
  fi
  if [ "$NO_SERVICE" -eq 0 ] && has_systemd; then
    say "Start the daemon with: systemctl --user restart $SERVICE"
  else
    say "Run the daemon with: $BIN run"
  fi
}

# The unit's ExecStart names the binary that ran install-service, so an
# existing service is pointed at this one and restarted with --refresh, which
# leaves the agent user and the sudoers rule as they are.
replace_on_rerun() {
  say "This machine is already enrolled, so only the binary was replaced."
  if [ -n "$CODE" ]; then
    say "The code was not used. To enrol this machine again, run: $BIN enroll <code> --server $HM_ORIGIN"
  fi
  if [ "$NO_SERVICE" -eq 1 ]; then
    say "Did not touch the service (--no-service). Restart the daemon yourself to load the new binary."
  elif ! has_systemd; then
    say "systemd was not found, so the daemon was not restarted. Restart it by hand: $BIN run"
  elif service_installed; then
    run_install_service --refresh
    if [ -f "$BIN_DIR/$LEGACY_NAME" ]; then
      say "The old $BIN_DIR/$LEGACY_NAME binary is no longer used. You can delete it."
    fi
  else
    say "No $SERVICE service is installed, so nothing was restarted. Restart the daemon yourself, or install the service with: $BIN install-service --refresh"
  fi
}

print_version() {
  if ! version_text=$("$BIN" --version </dev/null); then
    die "$BIN --version failed"
  fi
  # The daemon logs its version with a "[agentum] " prefix.
  version_text=$(printf '%s\n' "$version_text" | sed 's/^\[[^]]*\] //')
  say "agentum $version_text is installed at $BIN"
}

main() {
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  parse_args "$@"
  check_platform
  read_manifest
  install_binary
  check_path
  check_claude
  if [ -f "$CONFIG" ] || [ -f "$LEGACY_CONFIG" ]; then
    replace_on_rerun
  else
    setup_service
    enroll_machine
  fi
  print_version
}

main "$@"
