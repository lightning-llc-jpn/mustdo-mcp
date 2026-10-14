#!/bin/bash
# Install this repository's git hooks into the current clone (once per clone;
# worktrees share the hooks of the clone they were created from).
#   bash tools/git-hooks/install.sh
set -euo pipefail

src_dir="$(cd "$(dirname "$0")" && pwd)"
hooks_dir="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"

mkdir -p "$hooks_dir"
install -m 755 "$src_dir/commit-msg" "$hooks_dir/commit-msg"
echo "Installed: $hooks_dir/commit-msg"

# If core.hooksPath is set, git does not read the hook installed above
if hooks_path="$(git config --get core.hooksPath)"; then
  echo "Warning: core.hooksPath=$hooks_path is set, so the hook above is not used." >&2
  exit 1
fi
