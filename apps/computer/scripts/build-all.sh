#!/usr/bin/env bash
# Cross-compiles the release matrix in one pass. Static binaries, no runtime on the target.
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${AGENTUM_COMPUTER_VERSION:-}"
if [ -z "$version" ]; then
  version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$package_dir/package.json" | head -1)"
fi
if [ -z "$version" ]; then
  echo "could not determine a version; set AGENTUM_COMPUTER_VERSION" >&2
  exit 1
fi

rm -rf "$package_dir/bin"
mkdir -p "$package_dir/bin"
targets=("linux/amd64" "linux/arm64" "darwin/amd64" "darwin/arm64")

# The name is the contract with the server's /install.sh, which fetches
# <release_base>/latest/agentum-computer_<os>_<arch>.
for target in "${targets[@]}"; do
  goos="${target%%/*}"
  goarch="${target##*/}"
  output="bin/agentum-computer_${goos}_${goarch}"
  echo "building $output (version $version)"
  GOOS="$goos" GOARCH="$goarch" bash "$package_dir/scripts/go.sh" \
    go build -trimpath -ldflags "-s -w -X main.version=${version}" -o "$output" ./cmd/agentum-computer
done

# The installer verifies against this when it is present.
( cd "$package_dir/bin" && sha256sum agentum-computer_* > SHA256SUMS )

ls -l "$package_dir/bin"
cat "$package_dir/bin/SHA256SUMS"
