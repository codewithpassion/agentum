#!/usr/bin/env bash
# Runs a Go toolchain command against this package. Uses the host toolchain when one is
# installed (CI sets one up) and falls back to Docker, because contributors are not expected
# to install Go for a package the rest of the repository does not build.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -eq 0 ]; then
  echo "usage: go.sh <go-command> [args...]" >&2
  exit 2
fi

if command -v go >/dev/null 2>&1; then
  cd "$package_dir"
  export CGO_ENABLED="${CGO_ENABLED:-0}"
  export GOFLAGS="${GOFLAGS:--buildvcs=false}"
  exec "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "neither a Go toolchain nor docker is available; install one of them" >&2
  exit 127
fi

image="${AGENTUM_GO_IMAGE:-golang:1.23}"
# A named volume for the module cache keeps builds warm; it is chowned to the invoking user so
# the container leaves no root-owned files behind.
cache="${AGENTUM_GO_CACHE_VOLUME:-agentum-computer-gopkg}"
docker volume create "$cache" >/dev/null
docker run --rm -v "$cache":/go/pkg "$image" chown -R "$(id -u):$(id -g)" /go/pkg

# Only the package is mounted: mounting the repository root exposes a worktree .git file whose
# gitdir points outside the mount, and Go's VCS stamping then fails the build.
exec docker run --rm \
  -v "$package_dir":/src \
  -v "$cache":/go/pkg \
  -w /src \
  -u "$(id -u):$(id -g)" \
  -e CGO_ENABLED="${CGO_ENABLED:-0}" \
  -e HOME=/tmp \
  -e GOCACHE=/tmp/.gocache \
  -e GOFLAGS=-buildvcs=false \
  -e GOOS \
  -e GOARCH \
  "$image" "$@"
