#!/usr/bin/env bash
# The race detector needs cgo, which the ordinary build deliberately does not use, so it is
# its own script rather than a flag on the normal test run.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CGO_ENABLED=1 exec bash "$package_dir/scripts/go.sh" go test -race ./...
