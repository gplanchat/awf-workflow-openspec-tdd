#!/usr/bin/env bash
# EGM review of an OpenSpec change (Elephant-Goldfish Model, github.com/google/elephant-goldfish-model): the steps of
# flow-review. Each reviewer is a persona of the installed EGM plugin, run by a fresh agent with no prior context.
#
#   egm-review.sh root                      prints the EGM root: $EGM_ROOT, else the highest version installed by
#                                           Claude Code under ${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/egm/egm/;
#                                           exit 2 when none has an agents/ directory
#   egm-review.sh init <change>             checks the change and the EGM root, clears .awf/status/egm/
#   egm-review.sh decide <decision>         prints the decision: none, proceed, revise or abandon; exit 2 otherwise
#   egm-review.sh reviewers                 JSON list of the reviewers, in the order of the EGM stages
#   egm-review.sh brief <change> <reviewer> prints the instructions of one reviewer: the text of its persona and of its
#                                           standard, and the files of the change to read
#   egm-review.sh save <reviewer>           reads the reviewer's JSON on stdin into .awf/status/egm/<reviewer>.json;
#                                           exit 30 when it is not {"findings":[{severity,scope,finding,recommendation}]}
#   egm-review.sh report <change> <run>     writes .awf/status/egm/review.md and .awf/status/flow-review.json;
#                                           exit 0 without a Blocker, 10 with one
#   egm-review.sh ask <change> <run>        files the question about the Blockers through the ask operation of the
#                                           command contract (commands.sh ask)
#   egm-review.sh decided <change> <run> <decision>
#                                           records the decision in .awf/status/flow-review.json
#
# The feature part of a change is proposal.md, design.md and specs/; its implementation plan is tasks.md.
set -u

here=$(cd "$(dirname "$0")" && pwd)
status_dir=.awf/status/egm

die() { # die <code> <message>...
  local code=$1
  shift
  printf '%s\n' "$@" >&2
  exit "$code"
}

check_change() {
  [[ ${1:-} =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
    die 2 "The change name \"${1:-}\" is not in kebab-case." "Use lowercase letters, digits and hyphens, for example my-feature."
}

egm_root() {
  local root
  if [[ -n ${EGM_ROOT:-} ]]; then
    root=$EGM_ROOT
  else
    root=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/egm/egm/*/ 2>/dev/null | sort -V | tail -n1)
    root=${root%/}
  fi
  [[ -n $root && -d $root/agents ]] ||
    die 2 "The EGM plugin cannot be found${root:+ in $root}." \
      "Install it in Claude Code (claude plugin marketplace add google/elephant-goldfish-model, then claude plugin install egm@egm), or set EGM_ROOT to a copy of github.com/google/elephant-goldfish-model."
  printf '%s\n' "$root"
}

# reviewer -> persona file, document standard (or -), scope (feature, plan or all)
reviewer_spec() {
  case $1 in
    zoom-out) echo "zoom_out zoom-out-standard all" ;;
    comprehension) echo "comprehension - all" ;;
    design) echo "design_critic feature-spec-standard feature" ;;
    structural) echo "structural feature-spec-standard feature" ;;
    style) echo "style - all" ;;
    implementation-readiness) echo "implementation_readiness implementation-readiness-standard plan" ;;
    codebase-details) echo "codebase_details implementation-readiness-standard plan" ;;
    *) die 2 "Unknown reviewer \"$1\"." ;;
  esac
}

REVIEWERS='["zoom-out","comprehension","design","structural","style","implementation-readiness","codebase-details"]'

change_files() { # change_files <change> <scope>: the files of the change a reviewer reads
  local dir=openspec/changes/$1
  case $2 in
    feature | all)
      for file in "$dir/proposal.md" "$dir/design.md"; do [[ -f $file ]] && echo "$file"; done
      find "$dir/specs" -name spec.md 2>/dev/null | sort
      ;;
  esac
  case $2 in
    plan) [[ -f $dir/design.md ]] && echo "$dir/design.md (context only)" ;;
  esac
  case $2 in
    plan | all) [[ -f $dir/tasks.md ]] && echo "$dir/tasks.md" ;;
  esac
}

op_init() {
  local change=${1:-}
  check_change "$change"
  [[ -f openspec/changes/$change/proposal.md ]] ||
    die 2 "The change $change has no openspec/changes/$change/proposal.md here." "Run flow-review where the change is drafted, for example in .worktrees/propose-$change."
  egm_root >/dev/null || exit $?
  rm -rf "$status_dir" && mkdir -p "$status_dir"
}

op_decide() {
  case ${1:-} in
    none | proceed | revise | abandon) printf '%s' "$1" ;;
    *) die 2 "The decision \"${1:-}\" is not one of none, proceed, revise or abandon." ;;
  esac
}

op_brief() {
  local change=${1:-} reviewer=${2:-} root spec persona standard scope
  check_change "$change"
  root=$(egm_root) || exit $?
  spec=$(reviewer_spec "$reviewer") || exit 2
  read -r persona standard scope <<<"$spec"
  [[ -f $root/agents/$persona.md ]] || die 2 "The EGM persona $root/agents/$persona.md is missing." "Update the EGM plugin, or point EGM_ROOT at a complete copy."
  # The persona and the standard are given as text: the reviewer reads nothing outside the repository.
  printf '<persona>\n%s\n</persona>\n\nApply the persona above in Mode: REVIEW.\n' "$(awk 'NR == 1 && /^---$/ { front = 1; next } front && /^---$/ { front = 0; next } !front' "$root/agents/$persona.md")"
  if [[ $standard != - ]]; then printf '\n<target_standard>\n%s\n</target_standard>\n' "$(cat "$root/resources/document_standards/$standard.md")"; fi
  printf '\nThe Output Format of the persona does not apply: report the same fields (severity, scope, finding, recommendation) in the JSON object described at the end of this prompt.\n'
  printf '\nThe document under review is the OpenSpec change "%s". Read these files, and the files they link to:\n' "$change"
  change_files "$change" "$scope" | sed 's/^/- /'
  case $scope in
    feature) printf '\nThese files form the feature specification; tasks.md, the implementation plan, is out of scope.\n' ;;
    plan) printf '\nReview the implementation plan, tasks.md, against the design and the code of the repository.\n' ;;
  esac
}

op_save() {
  local reviewer=${1:-} file
  reviewer_spec "$reviewer" >/dev/null || exit 2
  mkdir -p "$status_dir"
  file=$status_dir/$reviewer.json
  jq -e '(.findings | type == "array") and all(.findings[]; (.severity | IN("Blocker","Major","Nit")) and (.finding | type == "string"))' >/dev/null 2>&1 < <(tee "$file") ||
    die 30 "The reviewer $reviewer returned no valid findings: $file is not {\"findings\":[{\"severity\":\"Blocker|Major|Nit\",\"scope\":...,\"finding\":...,\"recommendation\":...}]}."
}

count() { # count <severity>
  cat "$status_dir"/*.json 2>/dev/null | jq -s --arg s "$1" '[.[].findings[] | select(.severity == $s)] | length'
}

write_status() { # write_status <change> <run> <status>
  mkdir -p .awf/status
  # The commit reviewed: a review of an older version of the change does not count for /flow:accept.
  jq -n --arg change "$1" --arg run "$2" --arg status "$3" --arg commit "$(git rev-parse HEAD 2>/dev/null)" --argjson blockers "$(count Blocker)" --argjson majors "$(count Major)" --argjson nits "$(count Nit)" \
    '{change: $change, run: $run, commit: $commit, blockers: $blockers, majors: $majors, nits: $nits, report: ".awf/status/egm/review.md", status: $status}' >.awf/status/flow-review.json
}

op_report() {
  local change=${1:-} run=${2:-} reviewer severity
  check_change "$change"
  {
    printf '# EGM review of %s\n\nBlockers: %s, Majors: %s, Nits: %s.\n' "$change" "$(count Blocker)" "$(count Major)" "$(count Nit)"
    for severity in Blocker Major Nit; do
      printf '\n## %s\n' "$severity"
      for reviewer in $(jq -r '.[]' <<<"$REVIEWERS"); do
        [[ -f $status_dir/$reviewer.json ]] || continue
        jq -r --arg s "$severity" --arg r "$reviewer" '.findings[] | select(.severity == $s) | "\n- **\(.scope // "?")** (\($r)): \(.finding)\(if .recommendation then "\n  Recommendation: \(.recommendation)" else "" end)"' "$status_dir/$reviewer.json"
      done
    done
  } >"$status_dir/review.md"
  if [[ $(count Blocker) -gt 0 ]]; then
    write_status "$change" "$run" waiting
    exit 10
  fi
  write_status "$change" "$run" clean
}

op_ask() {
  local change=${1:-} run=${2:-}
  check_change "$change"
  bash "$here/commands.sh" ask --run "$run" --kind decision \
    --question "The EGM review of $change found $(count Blocker) Blocker(s), listed in .awf/status/egm/review.md. Proceed to acceptance, revise the change, or abandon it?" \
    --options proceed,revise,abandon --recommended revise --resume-step check --input egm_decision
}

op_decided() {
  local change=${1:-} run=${2:-}
  check_change "$change"
  case ${3:-} in
    proceed) write_status "$change" "$run" accepted ;;
    revise) write_status "$change" "$run" revise ;;
    abandon) write_status "$change" "$run" abandoned ;;
    *) die 2 "The decision \"${3:-}\" is not one of proceed, revise or abandon." ;;
  esac
}

operation=${1:-}
shift || true
case $operation in
  root) egm_root ;;
  init) op_init "$@" ;;
  decide) op_decide "$@" ;;
  reviewers) printf '%s\n' "$REVIEWERS" ;;
  brief) op_brief "$@" ;;
  save) op_save "$@" ;;
  report) op_report "$@" ;;
  ask) op_ask "$@" ;;
  decided) op_decided "$@" ;;
  *) die 2 "Unknown operation \"$operation\"." "Use root, init, decide, reviewers, brief, save, report, ask or decided." ;;
esac
