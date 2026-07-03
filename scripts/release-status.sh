#!/usr/bin/env bash
# At-a-glance view of every connector in this monorepo: current manifest
# version vs. the latest matching git tag, so it's obvious which connectors
# have unreleased changes without checking each one by hand.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$REPO_ROOT/scripts/connectors.conf"

printf "%-12s %-10s %-18s %s\n" "CONNECTOR" "VERSION" "LATEST TAG" "STATUS"
printf "%-12s %-10s %-18s %s\n" "---------" "-------" "----------" "------"

while IFS= read -r line; do
  [[ "$line" =~ ^#.*$ || -z "${line// }" ]] && continue
  name="$(echo "$line" | awk '{print $1}')"
  dir="$(echo "$line" | awk '{print $2}')"
  prefix="$(echo "$line" | awk '{print $3}')"
  # awk throughout, not `cut -d' '` -- connectors.conf uses aligned/padded
  # columns with multiple spaces, which awk collapses but `cut -d' '`
  # treats as literal per-space fields (silently wrong field count).
  reader="$(echo "$line" | awk '{for(i=4;i<=NF;i++) printf "%s ", $i}')"

  version="$(cd "$REPO_ROOT/$dir" && eval "$reader")"
  tag="${prefix}${version}"

  if git -C "$REPO_ROOT" rev-parse "$tag" >/dev/null 2>&1; then
    status="released (tag exists)"
  else
    status="⚠ not yet tagged -- run: scripts/release.sh $name --yes"
  fi

  printf "%-12s %-10s %-18s %s\n" "$name" "$version" "$tag" "$status"
done < <(grep -v '^#' "$CONF" | grep -v '^\s*$')
