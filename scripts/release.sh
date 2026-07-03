#!/usr/bin/env bash
# The single entry point for cutting a release for ANY connector in this
# monorepo. Reads connectors.conf (one source of truth for each connector's
# directory / tag prefix / how to read its current version) instead of
# hand-typing `git tag <prefix>-v<version>` per-connector, which is exactly
# how the jetbrains-v0.1.0 duplicate-publish failure happened: the tag got
# pushed before checking whether that version already existed anywhere.
#
# Usage:
#   scripts/release.sh <connector>              # dry-run: show the plan
#   scripts/release.sh <connector> --yes        # actually tag + push
#   scripts/release.sh --list                   # show every known connector
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$REPO_ROOT/scripts/connectors.conf"

usage() {
  echo "Usage: $0 <connector> [--yes]" >&2
  echo "       $0 --list" >&2
  exit 1
}

[ $# -ge 1 ] || usage

if [ "$1" = "--list" ]; then
  echo "Known connectors:"
  grep -v '^#' "$CONF" | grep -v '^\s*$' | awk '{print "  - "$1" ("$2", tag prefix \""$3"\")"}'
  exit 0
fi

CONNECTOR="$1"
CONFIRM="${2:-}"

LINE="$(grep -v '^#' "$CONF" | grep -v '^\s*$' | awk -v c="$CONNECTOR" '$1==c')"
if [ -z "$LINE" ]; then
  echo "Unknown connector '$CONNECTOR'. Known connectors:" >&2
  grep -v '^#' "$CONF" | grep -v '^\s*$' | awk '{print "  - "$1}' >&2
  exit 1
fi

DIR="$(echo "$LINE" | awk '{print $2}')"
PREFIX="$(echo "$LINE" | awk '{print $3}')"
# awk throughout, not `cut -d' '` -- connectors.conf uses aligned/padded
# columns with multiple spaces, which awk collapses but `cut -d' '` treats
# as literal per-space fields (silently wrong field count).
READER="$(echo "$LINE" | awk '{for(i=4;i<=NF;i++) printf "%s ", $i}')"

cd "$REPO_ROOT/$DIR"
VERSION="$(eval "$READER")"
TAG="${PREFIX}${VERSION}"

echo "Connector:  $CONNECTOR ($DIR)"
echo "Version:    $VERSION"
echo "Tag:        $TAG"
echo

cd "$REPO_ROOT"

# ── Safety checks -- all of these should block, not just warn ──────────────
FAIL=0

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ Uncommitted changes in the working tree -- commit or stash first."
  FAIL=1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "✗ Tag $TAG already exists locally."
  FAIL=1
fi

if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  echo "✗ Tag $TAG already exists on origin -- this version was already released."
  echo "  Bump the version in $DIR first if you meant to cut a NEW release."
  FAIL=1
fi

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main 2>/dev/null || echo '')"
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "✗ Local main ($LOCAL_HEAD) is not the same commit as origin/main ($REMOTE_HEAD)."
  echo "  Push your commits first: git push origin main"
  FAIL=1
fi

if [ "$FAIL" = "1" ]; then
  echo
  echo "Aborting -- fix the above before releasing."
  exit 1
fi

echo "✓ All checks passed."
echo

if [ "$CONFIRM" != "--yes" ]; then
  echo "Dry run only. Re-run with --yes to actually tag and push:"
  echo "  $0 $CONNECTOR --yes"
  exit 0
fi

git tag "$TAG"
git push origin "$TAG"
echo
echo "Pushed $TAG. Watch it with:"
echo "  gh run list --repo ByteAsk/byteask-extensions --limit 5"
