#!/usr/bin/env bash
# Gate of a performance slice: perf-gate.sh <baseline|check> <language> <slice text>
#
# The slice text carries its target: `target: -10% <bench>` (words between the percentage and the bench name are
# ignored, so `target: -10% instructions fib` works). The language entry of .awf/languages.yaml gives:
#   perf            command measuring one benchmark; {bench} is replaced by its name; the last line of its output is a
#                   number, lower is better (instruction count, nanoseconds...)
#   perf_benches    benchmarks watched for regressions besides the target one
#   perf_tolerance  regression allowed on the other benchmarks, in percent (default 2)
#
# baseline  measures every benchmark on the current tree, before the slice changes anything, and writes
#           .awf/status/perf-base.json. The baseline is never stored beyond the slice: it goes stale as soon as another
#           slice merges.
# check     measures again: the target benchmark must have dropped by the target percentage, and no other benchmark may
#           have grown by more than perf_tolerance. The report goes to .awf/status/review-last.txt.
#
# Exit codes: 0 gate passed, 2 bad usage or configuration, 20 target missed or regression, 12 a measurement failed.
set -uo pipefail
export LC_ALL=C # decimal point in awk output and comparisons

phase=${1:-}; language=${2:-}; slice=${3:-}
scripts=$(cd "$(dirname "$0")" && pwd)
base_file=${PERF_BASE_FILE:-.awf/status/perf-base.json}
report=${TDD_REVIEW_OUTPUT:-.awf/status/review-last.txt}

[[ $phase == baseline || $phase == check ]] && [[ -n $language ]] || { echo "Usage: perf-gate.sh <baseline|check> <language> <slice text>" >&2; exit 2; }

registry=$(bash "$scripts/openspec-tasks.sh" languages) || { echo "perf-gate: .awf/languages.yaml is missing or unreadable." >&2; exit 2; }
reg() { jq -r --arg l "$language" --arg k "$1" '.[$l][$k] // "" | if type == "array" then .[] else . end' <<<"$registry"; }
cmd=$(reg perf)
tolerance=$(reg perf_tolerance); tolerance=${tolerance:-2}
[[ -n $cmd ]] || { echo "perf-gate: the language $language has no \`perf\` command in .awf/languages.yaml." >&2; exit 2; }

if [[ $slice =~ target:[[:space:]]*-([0-9]+(\.[0-9]+)?)%.*[[:space:]]([^[:space:]]+)[[:space:]]*$ ]]; then
  gain=${BASH_REMATCH[1]}; target=${BASH_REMATCH[3]}
else
  echo "perf-gate: the slice text has no target. Write it as \`target: -10% <bench>\` at the end of the slice line." >&2
  exit 2
fi

benches=$( { echo "$target"; reg perf_benches; } | awk 'NF && !seen[$0]++')

# measure <bench>: runs the perf command and prints the number on its last line.
measure() {
  local out value
  out=$(bash -c "${cmd//\{bench\}/$1}" 2>&1) || { echo "$out" >&2; return 1; }
  value=$(tail -n1 <<<"$out" | tr -d '[:space:]')
  [[ $value =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "$out" >&2; echo "perf-gate: the last line of the perf output for $1 is not a number." >&2; return 1; }
  echo "$value"
}

mkdir -p "$(dirname "$base_file")" "$(dirname "$report")"

if [[ $phase == baseline ]]; then
  json='{}'
  for bench in $benches; do
    value=$(measure "$bench") || exit 12
    json=$(jq -c --arg b "$bench" --argjson v "$value" '. + {($b): $v}' <<<"$json")
  done
  jq -n --arg t "$target" --argjson g "$gain" --argjson b "$json" '{target: $t, gain: $g, base: $b}' >"$base_file"
  echo "Baseline of $(wc -w <<<"$benches") benchmark(s) written to $base_file; target: -$gain% on $target."
  exit 0
fi

[[ -f $base_file ]] || { echo "perf-gate: no baseline in $base_file. Run the baseline phase at the start of the slice." >&2; exit 2; }
failed=0
{
  for bench in $benches; do
    base=$(jq -r --arg b "$bench" '.base[$b] // empty' "$base_file")
    [[ -n $base ]] || { echo "$bench: no baseline value"; failed=1; continue; }
    value=$(measure "$bench") || { echo "$bench: measurement failed"; exit 12; }
    change=$(awk -v n="$value" -v b="$base" 'BEGIN { printf "%.2f", (b == 0 ? 0 : (n - b) * 100 / b) }')
    if [[ $bench == "$target" ]]; then
      ok=$(awk -v c="$change" -v g="$gain" 'BEGIN { print (c <= -g) }')
      verdict="target -$gain%"
    else
      ok=$(awk -v c="$change" -v t="$tolerance" 'BEGIN { print (c <= t) }')
      verdict="tolerance +$tolerance%"
    fi
    (( ok )) || failed=1
    echo "$bench: $base -> $value ($change%), $verdict: $([[ $ok == 1 ]] && echo ok || echo FAILED)"
  done
  exit "$failed"
} | tee "$report"
rc=${PIPESTATUS[0]}
(( rc == 12 )) && exit 12
(( rc == 0 )) || { echo; echo "perf: target missed or regression above $tolerance% on another benchmark (see above)."; exit 20; }
exit 0
