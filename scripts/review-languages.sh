#!/usr/bin/env bash
# review-languages.sh <change>: prints, as a JSON array, the languages of the registry (.awf/languages.yaml) that the
# final review of apply-change covers, in registry order. Run it before the tasks are applied, from the root of the
# change's worktree.
#
# A language is touched when an open slice of tasks.md carries its tag (`  - [ ] 2.1.1 [php] ...`, the first tag other
# than [critical]), or when an open task without slices (former rule) is classified in it by openspec-tasks.sh.
# Only languages with `review_steps` are kept. Two keys whose review is the same (`review_steps` and `checks`, as an
# alias and its target) are reviewed once, under the first key in the registry.
#
# Exit codes: 0 success, 2 tasks.md or the registry cannot be read.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
change=${1:-}
tasks=openspec/changes/$change/tasks.md
[[ -n $change && -f $tasks ]] || {
  echo "The file $tasks cannot be found." "Run review-languages.sh from the root of the change's worktree, with the change name." >&2
  exit 2
}

slices=$(awk '/^  - \[ \] [0-9]+\.[0-9]+\.[0-9]+ \[/ {
  for (i = 5; i <= NF && $i ~ /^\[[a-z0-9-]+\]$/; i++) { t = substr($i, 2, length($i) - 2); if (t != "critical") { print t; break } }
}' "$tasks")

open=$(bash "$here/openspec-tasks.sh" list "$change") || exit 2
legacy=$(jq -r '.[] | select(.kind != "manual") | "\(.id) \(.hexagon)"' <<<"$open" | while read -r id hexagon; do
  grep -qE "^  - \[.\] ${id//./\\.}\.[0-9]+ " "$tasks" || echo "$hexagon"
done)

bash "$here/openspec-tasks.sh" languages | jq -c --arg touched "$slices"$'\n'"$legacy" '
  ($touched | split("\n") | map(select(. != ""))) as $t
  | [to_entries[] | select(.key as $k | $t | index($k)) | select((.value.review_steps // []) | length > 0)
     | {key, review: (.value | {review_steps, checks})}]
  | reduce .[] as $e ([]; if any(.[]; .review == $e.review) then . else . + [$e] end)
  | map(.key)' || exit 2
