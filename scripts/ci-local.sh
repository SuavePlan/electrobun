#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_name="electrobun-ext-ci:local"

docker build \
  --file "$repo_root/.github/ci/Dockerfile" \
  --tag "$image_name" \
  "$repo_root"

docker run --rm \
  --mount "type=bind,src=$repo_root,dst=/source,readonly" \
  "$image_name"
