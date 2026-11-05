#!/bin/sh
# Keep all work in main so a truncated curl response cannot run half an install.
set -eu
CODE="${AGENTUM_ENROLL_CODE:-}"
unset AGENTUM_ENROLL_CODE
HM_ORIGIN="@@HM_ORIGIN@@"
PRODUCT=agentum-rs
BIN_DIR="${HOME:?HOME is not set}/.local/bin"
MODE=user
if [ "$(id -u)" = 0 ]; then
  BIN_DIR=/usr/local/bin
  MODE=system
fi
BIN="$BIN_DIR/agentum"
INSTANCE=""
RUN_AS=current
REPLACE_OLD=false
CODE_STDIN=false
TMP_BIN=""
say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
cleanup() { if [ -n "$TMP_BIN" ]; then rm -f "$TMP_BIN"; fi; }
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --code | --run-as | --instance)
        [ "$#" -ge 2 ] && [ -n "$2" ] || die "option needs a value"
        case "$1" in --code) CODE="$2" ;; --run-as) RUN_AS="$2" ;; --instance) INSTANCE="$2" ;; esac
        shift 2 ;;
      --code-stdin) CODE_STDIN=true; shift ;;
      --replace-old) REPLACE_OLD=true; shift ;;
      -h | --help)
        say 'Usage: AGENTUM_ENROLL_CODE=<code> sh install-agentum.sh [--code-stdin] [--instance <name>] [--run-as current|<user>|agent-user] [--replace-old]'
        say 'A code creates a new instance. Use --instance <name> to replace an enrolled instance.'
        say 'Use --code-stdin to read a code from stdin. Without a code, updates existing instances.'
        exit 0 ;;
      *) die 'unknown option (see --help)' ;;
    esac
  done
  if [ "$MODE" = user ] && [ "$RUN_AS" != current ]; then
    die 'Named users and agent-user require root. Run this installer as root.'
  fi
}
# Under sudo, the invoking user's bus needs its runtime directory as well.
user_systemctl() {
  if [ -n "$OLD_USER" ]; then
    runuser -u "$OLD_USER" -- env "XDG_RUNTIME_DIR=/run/user/$OLD_UID" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$OLD_UID/bus" systemctl --user "$@"
  else
    systemctl --user "$@"
  fi
}
retire_user_daemon() {
  if [ -f "$OLD_HOME/.agentum/config.json" ] ||
    [ -f "$OLD_HOME/.config/systemd/user/agentum.service" ] ||
    user_systemctl cat agentum.service >/dev/null 2>&1; then
    [ "$REPLACE_OLD" = true ] || die 'Old daemon found. Use --replace-old to stop and disable it before replacing the binary.'
    if [ -f "$OLD_HOME/.config/systemd/user/agentum.service" ] || user_systemctl cat agentum.service >/dev/null 2>&1; then
      user_systemctl disable --now agentum.service
      rm -f "$OLD_HOME/.config/systemd/user/agentum.service"
      user_systemctl daemon-reload
    fi
    if [ -f "$OLD_HOME/.agentum/config.json" ]; then
      mv "$OLD_HOME/.agentum/config.json" "$OLD_HOME/.agentum/config.json.replaced"
    fi
    RETIRED=true
  fi
}
check_old() {
  RETIRED=false
  # Refuse before changing any user unit when root is needed for the system unit.
  if [ -f /etc/systemd/system/agentum.service ] || systemctl cat agentum.service >/dev/null 2>&1; then
    [ "$REPLACE_OLD" = true ] || die 'Old daemon found. Use --replace-old to stop and disable it before replacing the binary.'
    [ "$MODE" = system ] || die 'run as root to replace the system unit'
    systemctl disable --now agentum.service
    rm -f /etc/systemd/system/agentum.service
    systemctl daemon-reload
    RETIRED=true
  fi
  OLD_HOME="$HOME"
  OLD_USER=""
  if [ "$MODE" = system ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    SUDO_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    [ -n "$SUDO_HOME" ] || die "could not find home for $SUDO_USER"
    OLD_UID=$(id -u "$SUDO_USER")
    if [ "$SUDO_HOME" != "$HOME" ]; then retire_user_daemon; fi
    OLD_HOME="$SUDO_HOME"
    OLD_USER="$SUDO_USER"
  fi
  retire_user_daemon
  if [ "$RETIRED" = true ]; then
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


restart_service() {
  if "$BIN" service installed --instance "$instance"; then
    :
  else
    installed_status=$?
    if [ "$installed_status" = 1 ]; then return 1; fi
    printf 'warning: could not check whether %s has a service\n' "$instance" >&2
    return 2
  fi
  if "$BIN" service restart --instance "$instance"; then
    say "Updated and restarted $instance. Next: $BIN service status --instance $instance"
  else
    printf 'warning: could not restart %s\n' "$instance" >&2
    return 2
  fi
}
instances() {
  CONFIG_ROOT="${AGENTUM_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/agentum}"
  if [ "$MODE" = system ]; then CONFIG_ROOT=/etc/agentum; fi
  for config in "$CONFIG_ROOT"/*/config.json; do
    [ -f "$config" ] || continue
    instance=${config%/config.json}
    instance=${instance##*/}
    FOUND=true
    if [ -n "$CODE" ] && [ "$instance" = "$INSTANCE" ]; then continue; fi
    restart_service || :
  done
}
enroll_machine() {
  [ -n "$CODE" ] || die 'Supply AGENTUM_ENROLL_CODE=<code> (or --code-stdin) from the Machines page.'
  set -- enroll --url "$HM_ORIGIN" --code-stdin --json
  if [ -n "$INSTANCE" ]; then
    [ -f "$CONFIG_ROOT/$INSTANCE/config.json" ] || die "instance $INSTANCE is not enrolled"
    set -- "$@" --instance "$INSTANCE" --replace
  else
    set -- "$@" --run-as "$RUN_AS"
    if [ "$MODE" = system ]; then set -- "$@" --system; fi
  fi
  answer=$(printf '%s\n' "$CODE" | "$BIN" "$@") || die 'Enrolment failed. See the message above.'
  CODE=""
  instance=$(printf '%s\n' "$answer" | sed -n 's/.*"instance"[[:space:]]*:[[:space:]]*"\([a-z0-9-]*\)".*/\1/p')
  [ -n "$instance" ] || die 'Enrolment returned no instance name. Run agentum list to find the saved enrolment.'
  say "Enrolled $instance."
  if [ -n "$INSTANCE" ]; then
    # Replacement keeps the enrolled run-as, which can differ from this invocation.
    RUN_AS=$(printf '%s\n' "$answer" | sed -n 's/.*"runAs"[[:space:]]*:[[:space:]]*"\([a-zA-Z0-9_-]*\)".*/\1/p')
    [ -n "$RUN_AS" ] || die 'Enrolment returned no run-as. Run agentum status to inspect the saved enrolment.'
    if restart_service; then
      :
    else
      restart_status=$?
      if [ "$restart_status" = 1 ]; then
        say "Next: $BIN service install --$MODE --run-as $RUN_AS --instance $instance --yes"
      else
        die "Enrolled $instance, but its service could not be restarted. See the message above."
      fi
    fi
  else
    "$BIN" service install "--$MODE" --run-as "$RUN_AS" --instance "$instance" --yes ||
      die "Enrolled $instance, but its service was not installed. Fix the problem above, then run: $BIN service install --$MODE --run-as $RUN_AS --instance $instance --yes"
    say "Installed its $MODE service."
    say "Next: $BIN service status --instance $instance"
  fi
}
main() {
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  parse_args "$@"
  # Read before scanning instances so a stdin code can replace the selected one.
  if [ "$CODE_STDIN" = true ] && [ -z "$CODE" ]; then
    IFS= read -r CODE || :
  fi
  check_platform
  check_old
  read_manifest
  install_binary
  FOUND=false
  instances
  if [ -n "$CODE" ] || [ "$FOUND" = false ]; then enroll_machine; fi
}
main "$@"
