#!/usr/bin/env bash
set -euo pipefail

# Skills contains procedures, not a compiler/release. Build an official checkout.
source_root="${SYMPP_SERVICE_SOURCE:-${XDG_DATA_HOME:-$HOME/.local/share}/symphony-plus-plus/source}"
ref="${SYMPP_SERVICE_REF:-beta}"
if [[ ! -d "$source_root/.git" ]]; then
  git clone --depth 1 --branch "$ref" https://github.com/JJLiebig/symphony-plus-plus.git "$source_root"
else
  [[ -z "$(git -C "$source_root" status --porcelain)" ]] || { echo 'Service source checkout has local changes.' >&2; exit 1; }
  git -C "$source_root" fetch origin "$ref"
  git -C "$source_root" checkout --detach FETCH_HEAD
fi
exec bash "$source_root/scripts/install-sympp-checkout.sh"
