#!/usr/bin/env bash
# Mirror every self-hosted Kody package repo into one private GitHub repo.
# Each package becomes branch `<namespace>/<repo>` in $KODY_MIRROR_REMOTE.
# Force-pushes so GitHub always matches the local source of truth.
set -euo pipefail

GIT_ROOT="${KODY_GIT_ROOT:-$HOME/.local/share/kody-selfhost/git}"
REMOTE="${KODY_MIRROR_REMOTE:-https://github.com/wbunting/kody-packages.git}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kody-git-mirror"
mkdir -p "$STATE_DIR"

# gh supplies the GitHub credential; nothing is written to disk.
export GIT_TERMINAL_PROMPT=0
auth=(-c credential.helper= -c "credential.helper=!gh auth git-credential")

pushed=0 skipped=0 failed=0
for repo in "$GIT_ROOT"/*/*.git; do
	[ -f "$repo/HEAD" ] || continue
	ns=$(basename "$(dirname "$repo")")
	name=$(basename "$repo" .git)
	head=$(git --git-dir="$repo" rev-parse --verify --quiet HEAD || true)
	[ -n "$head" ] || { skipped=$((skipped+1)); continue; }
	marker="$STATE_DIR/$ns--$name"
	if [ "$(cat "$marker" 2>/dev/null || true)" = "$head" ]; then
		skipped=$((skipped+1)); continue
	fi
	if git --git-dir="$repo" "${auth[@]}" push --quiet --force "$REMOTE" "HEAD:refs/heads/$ns/$name" 2>"$STATE_DIR/last-error"; then
		echo "$head" >"$marker"; pushed=$((pushed+1))
	else
		echo "mirror failed: $ns/$name: $(cat "$STATE_DIR/last-error")" >&2; failed=$((failed+1))
	fi
done
echo "kody-git-mirror: pushed=$pushed unchanged=$skipped failed=$failed"
[ "$failed" -eq 0 ]
