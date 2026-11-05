#!/bin/sh
# Keep all work in main so a truncated curl response cannot run half an install.
set -eu
HM_ORIGIN="@@HM_ORIGIN@@"
PRODUCT=agentum-rs
BIN_DIR="${HOME:?HOME is not set}/.local/bin"
MODE=user
if [ "$(id -u)" = 0 ]; then
  BIN_DIR=/usr/local/bin
  MODE=system
fi
BIN="$BIN_DIR/agentum"
CODE=""
RUN_AS=current
REPLACE_OLD=false
TMP_BIN=""
say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
cleanup() { if [ -n "$TMP_BIN" ]; then rm -f "$TMP_BIN"; fi; }
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --code | --run-as)
        [ "$#" -ge 2 ] && [ -n "$2" ] || die "option needs a value"
        case "$1" in --code) CODE="$2" ;; --run-as) RUN_AS="$2" ;; esac
        shift 2 ;;
      --replace-old) REPLACE_OLD=true; shift ;;
      -h | --help)
        say 'Usage: install-agentum.sh [--code <code>] [--run-as current|<user>|agent-user] [--replace-old]'
        say 'Without --code, reads a code from stdin, or updates existing instances.'
        exit 0 ;;
      *) die 'unknown option (see --help)' ;;
    esac
  done
  if [ "$MODE" = user ] && [ "$RUN_AS" != current ]; then
    die 'Named users and agent-user require root. Run this installer as root.'
  fi
}
old_daemon() {
  [ -f "$HOME/.agentum/config.json" ] ||
    [ -f "$HOME/.config/systemd/user/agentum.service" ] ||
    [ -f /etc/systemd/system/agentum.service ] ||
    systemctl --user cat agentum.service >/dev/null 2>&1 ||
    systemctl cat agentum.service >/dev/null 2>&1
}
check_old() {
  if old_daemon; then
    [ "$REPLACE_OLD" = true ] || die 'Old daemon found. Use --replace-old to stop and disable it before replacing the binary.'
    if systemctl --user cat agentum.service >/dev/null 2>&1 || [ -f "$HOME/.config/systemd/user/agentum.service" ]; then
      systemctl --user disable --now agentum.service
    fi
    if systemctl cat agentum.service >/dev/null 2>&1 || [ -f /etc/systemd/system/agentum.service ]; then
      systemctl disable --now agentum.service
    fi
    say 'Stopped and disabled the old daemon. Please revoke the old machine on the Machines page.'
  fi
}
check_platform() {
  [ "$(uname -s)" = Linux ] || die 'Agentum supports Linux only.'
  case "$(uname -m)" in
    x86_64 | amd64) FILE=agentum-linux-x64 ;;
    aarch64 | arm64) FILE=agentum-linux-arm64 ;;
    *) die 'Agentum supports x64 and arm64 only.' ;;
  esac
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


instances() {
  CONFIG_ROOT="${AGENTUM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/agentum}"
  if [ "$MODE" = system ]; then CONFIG_ROOT=/etc/agentum; fi
  for config in "$CONFIG_ROOT"/*/config.json; do
    [ -f "$config" ] || continue
    instance=${config%/config.json}
    instance=${instance##*/}
    "$BIN" service restart --instance "$instance"
    say "Updated and restarted $instance. Next: $BIN service status --instance $instance"
    FOUND=true
  done
}
enroll_machine() {
  if [ -z "$CODE" ]; then
    IFS= read -r CODE || :
  fi
  [ -n "$CODE" ] || die 'Supply --code or a code on stdin from the Machines page.'
  set -- enroll --url "$HM_ORIGIN" --code-stdin --json --run-as "$RUN_AS"
  if [ "$MODE" = system ]; then set -- "$@" --system; fi
  answer=$(printf '%s\n' "$CODE" | "$BIN" "$@") || die 'Enrolment failed. See the message above.'
  CODE=""
  instance=$(printf '%s\n' "$answer" | sed -n 's/.*"instance"[[:space:]]*:[[:space:]]*"\([a-z0-9-]*\)".*/\1/p')
  [ -n "$instance" ] || die 'Enrolment returned no instance name. Run agentum list to find the saved enrolment.'
  "$BIN" service install "--$MODE" --run-as "$RUN_AS" --instance "$instance" --yes
  say "Enrolled $instance and installed its $MODE service."
  say "Next: $BIN service status --instance $instance"
}
main() {
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  parse_args "$@"
  check_platform
  check_old
  read_manifest
  install_binary
  FOUND=false
  instances
  if [ -n "$CODE" ] || [ "$FOUND" = false ]; then enroll_machine; fi
}
main "$@"
