#!/usr/bin/env bash
# Traceability of critical scenarios: critical-trace.sh <change> <language>
#
# A scenario is critical when the first non-empty line under its `#### Scenario: <title>` heading in
# openspec/changes/<change>/specs/ is `critical: <category>[, <category>...]`. Categories: data-loss, data-leak, revenue,
# reputation, safety.
# Each critical scenario needs at least one test that carries the comment `// scenario: <exact title>` (or
# `# scenario: <exact title>`), in a file tracked by git that matches the `tests` patterns of the language in
# .awf/languages.yaml or sits under one of its `harness_paths` (fuzz/, benches/...).
#
# Exit codes: 0 every critical scenario is linked (or there is none), 30 a scenario has no linked test or an unknown
# category, 2 bad usage or unreadable registry.
set -uo pipefail
export LC_ALL=C

change=${1:-}; language=${2:-}
[[ -n $change && -n $language ]] || { echo "Usage: critical-trace.sh <change> <language>" >&2; exit 2; }
scripts=$(cd "$(dirname "$0")" && pwd)
root=${OPENSPEC_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
cd "$root" || exit 2
registry=$(bash "$scripts/openspec-tasks.sh" languages) || { echo "critical-trace: .awf/languages.yaml is missing or unreadable." >&2; exit 2; }
tests=$(jq -r --arg l "$language" '.[$l].tests // [] | join("|")' <<<"$registry")
mapfile -t harness < <(jq -r --arg l "$language" '.[$l].harness_paths // [] | .[]' <<<"$registry")

specs=openspec/changes/$change/specs
[[ -d $specs ]] || { echo "No specs folder in $specs: no critical scenario to trace."; exit 0; }

# One line per critical scenario: <categories>\t<title>
scenarios=$(find "$specs" -name '*.md' -print0 | xargs -0 -r awk '
  /^#### Scenario:/ { title = $0; sub(/^#### Scenario:[ \t]*/, "", title); sub(/[ \t]+$/, "", title); pending = 1; next }
  pending && NF == 0 { next }
  pending { if ($0 ~ /^critical:/) { c = $0; sub(/^critical:[ \t]*/, "", c); print c "\t" title } pending = 0 }
')
[[ -n $scenarios ]] || { echo "No critical scenario in $specs."; exit 0; }

# Untracked files count: RED's new tests are not committed yet when this runs.
files=$( { [[ -n $tests ]] && git ls-files --cached --others --exclude-standard | grep -E "$tests"; (( ${#harness[@]} )) && git ls-files --cached --others --exclude-standard -- "${harness[@]}"; } | sort -u)

failed=0
while IFS=$'\t' read -r categories title; do
  for category in ${categories//,/ }; do
    case $category in
      data-loss|data-leak|revenue|reputation|safety) ;;
      *) echo "Critical scenario with an unknown category « $category »: $title (allowed: data-loss, data-leak, revenue, reputation, safety)"; failed=1 ;;
    esac
  done
  if [[ -z $files ]] || ! xargs -d '\n' -r grep -lF -e "// scenario: $title" -e "# scenario: $title" -- <<<"$files" 2>/dev/null | grep -q .; then
    echo "Critical scenario without a linked test: $title"
    failed=1
  fi
done <<<"$scenarios"

if (( failed )); then
  echo
  echo "trace: add a test carrying \`// scenario: <exact title>\` for each scenario above, in a test file or under harness_paths."
  exit 30
fi
echo "trace: $(wc -l <<<"$scenarios") critical scenario(s), each linked to a test."
