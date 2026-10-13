#!/usr/bin/env bash
# Builds the desktop image and runs the desktop integration tests inside it, twice: once with the
# documented seccomp profile, where everything must work, and once with Docker's default profile,
# where Chromium's sandbox must be refused and reported rather than bypassed. Then it checks that
# Chromium's profile opens in a new container on the same volume.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${AGENTUM_DESKTOP_IMAGE:-agentum-computer-desktop:local}"
test_binary="bin/desktop-integration.test"
seccomp="$package_dir/packaging/desktop/seccomp.json"

docker build -f "$package_dir/Dockerfile.desktop" -t "$image" "$package_dir"
mkdir -p "$package_dir/bin"
bash "$package_dir/scripts/go.sh" go test -c -tags desktop_integration -o "$test_binary" ./internal/agent

run_tests() {
  docker run --rm --init \
    -v "$package_dir/bin:/tests:ro" \
    --entrypoint "/tests/$(basename "$test_binary")" \
    "$@" \
    "$image" -test.v -test.run 'TestDesktop'
}

echo "== with --security-opt seccomp=packaging/desktop/seccomp.json"
run_tests --security-opt "seccomp=$seccomp"

echo "== with Docker's default seccomp profile"
run_tests -e AGENTUM_DESKTOP_EXPECT_SANDBOX=refused

# A container recreated without --hostname gets a new one, and Chromium reads the lock its
# predecessor left, which names the old hostname, as a profile in use on another computer.
echo "== chromium's profile survives a new container with a new hostname"
volume="agentum-desktop-profile-test-$$"
docker volume create "$volume" >/dev/null
trap 'docker rm -f "$volume-a" >/dev/null 2>&1 || true; docker volume rm -f "$volume" >/dev/null 2>&1 || true' EXIT
profile=/var/lib/agentum-computer/desktop/chromium-profile

# Starts Xvfb, then runs the given chromium in the background and prints where its profile lock
# points once the browser has had time to take it.
browse='
  mkdir -p /var/lib/agentum-computer/desktop
  Xvfb :5 -nolisten tcp -nolisten local >/dev/null 2>&1 &
  sleep 1
  DISPLAY=:5 "$@" about:blank >/dev/null 2>&1 &
  for _ in $(seq 1 60); do
    case "$(readlink '"$profile"'/SingletonLock 2>/dev/null)" in "$(hostname)"-*) break ;; esac
    sleep 0.5
  done
  sleep 2
  readlink '"$profile"'/SingletonLock || echo none
'
in_container() {
  local hostname="$1"
  shift
  docker run --rm --hostname "$hostname" --security-opt "seccomp=$seccomp" \
    -v "$volume:/var/lib/agentum-computer" --entrypoint sh "$image" -c "$browse" sh "$@"
}

# Container A takes the profile and is killed, so its lock stays behind.
docker run -d --name "$volume-a" --hostname host-a --security-opt "seccomp=$seccomp" \
  -v "$volume:/var/lib/agentum-computer" --entrypoint sh "$image" -c "$browse; sleep 600" sh chromium >/dev/null
for _ in $(seq 1 60); do
  docker logs "$volume-a" 2>/dev/null | grep -q '^host-a-' && break
  sleep 1
done
docker rm -f "$volume-a" >/dev/null

# Chromium itself, without the wrapper, reproduces the stale lock: it never takes the profile.
lock="$(in_container host-b /usr/bin/chromium --user-data-dir="$profile")"
case "$lock" in
  host-a-*) echo "without the wrapper the lock still names host-a ($lock), as expected" ;;
  *) echo "FAIL: the stale lock did not reproduce; the lock is $lock" >&2; exit 1 ;;
esac

# Through the wrapper, a new hostname opens the profile.
lock="$(in_container host-c chromium)"
case "$lock" in
  host-c-*) echo "PASS: the wrapper opened the profile on host-c ($lock)" ;;
  *) echo "FAIL: chromium did not take the profile on host-c; the lock is $lock" >&2; exit 1 ;;
esac
