#!/usr/bin/env bash
# Merge gate of the main branch (BASE_BRANCH, main by default): merge-gate.sh merge <branch> <message> | check | install
#   merge    in the worktree that has the main branch checked out, merges <branch> with --no-ff --no-commit, runs `check`, then commits the merge (MERGE_GATE_DONE=1) or
#            aborts it (git merge --abort); the main branch keeps its previous commit.
#   check    checks the result of a merge in progress (files of `git diff --cached --name-only HEAD`): for each
#            language of the registry .awf/languages.yaml whose directory `dir` holds a file of the merge, runs the
#            commands of its `merge_checks` table, in registry order. The same name with the same command runs once
#            (aliases, languages that share a directory). Exits 0 without running anything outside the main branch or
#            when MERGE_GATE_DONE=1; exits 2 when the registry cannot be read.
#   install  turns on the pack's pre-merge-commit hook (git config core.hooksPath <pack>/hooks) for merges made by
#            hand; exits 2 when .git/hooks/ already holds an active hook.
# MERGE_GATE_CMD_<NAME> replaces a step: the table name in upper case, each character outside [A-Z0-9] replaced by _
# (phpstan gives MERGE_GATE_CMD_PHPSTAN).
# Each check writes .awf/status/merge-gate.json (steps run, seconds of each, total) and, beyond MERGE_GATE_BUDGET
# seconds (180 by default), a warning on standard error; the duration never fails the gate.
#   0   merge committed or checks passed
#   2   wrong usage, merge impossible or conflict (merge aborted)
#   30  a check step fails (merge aborted by `merge`)
set -uo pipefail
unset LC_ALL; export LC_NUMERIC=C # EPOCHREALTIME and awk follow the locale for the decimal separator

usage() { echo "usage: merge-gate.sh merge <branch> <message> | check | install" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
base=${BASE_BRANCH:-main}

RAN=() T0=0

# finish <code>: writes the report (temporary file renamed), warns when the budget is exceeded, exits.
finish() {
  local total json='' e dir=.awf/status budget=${MERGE_GATE_BUDGET:-180}
  local now=$EPOCHREALTIME
  total=$(awk -v a="$T0" -v b="$now" 'BEGIN { printf "%.2f", b - a }')
  for e in "${RAN[@]+"${RAN[@]}"}"; do json+="${json:+,}{\"step\":\"${e% *}\",\"seconds\":${e#* }}"; done
  mkdir -p "$dir" && printf '{"steps":[%s],"total":%s}\n' "$json" "$total" >"$dir/merge-gate.json.tmp" \
    && mv "$dir/merge-gate.json.tmp" "$dir/merge-gate.json"
  awk -v a="$T0" -v b="$now" -v m="$budget" 'BEGIN { exit !(b - a > m) }' \
    && echo "merge-gate: warning, $total s is over the budget of $budget s (MERGE_GATE_BUDGET)" >&2
  exit "$1"
}

step() { # step <STEP> <default command>
  local var=MERGE_GATE_CMD_$1 cmd=$2 t=$EPOCHREALTIME rc=0
  cmd=${!var:-$cmd}
  echo "merge-gate: step $1" >&2
  bash -c "$cmd" >&2 || rc=$?
  RAN+=("$1 $(awk -v a="$t" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.2f", b - a }')")
  if [ $rc -ne 0 ]; then
    echo "merge-gate: step $1 failed (command: $cmd)" >&2
    finish 30
  fi
}

check() {
  [ "${MERGE_GATE_DONE:-}" = 1 ] && exit 0
  [ "$(git symbolic-ref --short -q HEAD)" = "$base" ] || exit 0
  cd "$(git rev-parse --show-toplevel)" || exit 2
  local files registry dir name cmd seen=$'\n' snapshot
  T0=$EPOCHREALTIME
  files=$(git diff --cached --name-only HEAD)
  # The registry read is the one of the main branch before the merge (HEAD), so a branch cannot remove its own
  # checks. A language whose checks the merge adds is checked from the next merge on.
  snapshot=$(mktemp -d) || exit 2
  mkdir -p "$snapshot/.awf"
  # One line per check: directory, name, command, separated by tabs, in registry order.
  registry=$(git show HEAD:.awf/languages.yaml >"$snapshot/.awf/languages.yaml" &&
    OPENSPEC_ROOT=$snapshot bash "$here/openspec-tasks.sh" languages | jq -r '
    to_entries[] | .value as $l | select(($l.dir // "") != "")
    | $l.merge_checks | to_entries[] | [$l.dir, .key, .value] | @tsv') || {
    rm -rf "$snapshot"
    echo "merge-gate: the registry .awf/languages.yaml of branch $base is missing or cannot be read, so no merge check can be chosen." >&2
    echo "Commit a valid registry on $base (openspec-tasks.sh languages must succeed), then merge again." >&2
    exit 2
  }
  rm -rf "$snapshot"
  while IFS=$'\t' read -r dir name cmd; do
    [ -n "$name" ] || continue
    # `dir: .` is the root of the repository: every file of the merge touches it.
    if [ "${dir%/}" = . ]; then [ -n "$files" ] || continue; else grep -q "^${dir%/}/" <<<"$files" || continue; fi
    [[ $seen == *$'\n'"$name"$'\t'"$cmd"$'\n'* ]] && continue
    seen+="$name"$'\t'"$cmd"$'\n'
    name=${name^^}
    step "${name//[^A-Z0-9]/_}" "$cmd"
  done <<<"$registry"
  finish 0
}

merge() {
  [ $# -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] || usage
  local branch=$1 message=$2 conflicts rc
  git rev-parse --verify -q "$branch^{commit}" >/dev/null || { echo "merge-gate: branch $branch does not exist" >&2; exit 2; }
  # The merge happens in the worktree that has the main branch checked out, whichever it is.
  local tree
  tree=$(git worktree list --porcelain | awk -v b="branch refs/heads/$base" '/^worktree /{w=substr($0,10)} $0==b{print w; exit}')
  [ -n "$tree" ] || { echo "merge-gate: no worktree has branch $base checked out; check it out in one, then run again" >&2; exit 2; }
  cd "$tree" || exit 2
  git merge --no-ff --no-commit "$branch" >&2
  rc=$?
  if [ $rc -ne 0 ]; then
    conflicts=$(git diff --name-only --diff-filter=U)
    git merge --abort 2>/dev/null
    [ -n "$conflicts" ] && echo "merge-gate: conflict in:"$'\n'"$conflicts" >&2 || echo "merge-gate: the merge of $branch failed" >&2
    exit 2
  fi
  # Branch already contained in the main branch: git prepares no merge.
  git rev-parse -q --verify MERGE_HEAD >/dev/null || { echo "merge-gate: nothing to merge" >&2; exit 0; }
  (check) || { rc=$?; git merge --abort; exit $rc; }
  MERGE_GATE_DONE=1 git commit -q -m "$message" >&2
}

install() {
  local hooks active
  hooks=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/hooks || usage
  active=$(find "$hooks" -maxdepth 1 -type f ! -name '*.sample' 2>/dev/null)
  if [ -n "$active" ]; then
    echo "merge-gate: $hooks holds an active hook, which core.hooksPath would hide:"$'\n'"$active"$'\n'"Move it out of this directory or delete it, then run install again." >&2
    exit 2
  fi
  local pack_hooks
  pack_hooks=$(cd "$here/../hooks" 2>/dev/null && pwd) || { echo "merge-gate: the pack's hooks directory cannot be found next to $here." >&2; exit 2; }
  git config core.hooksPath "$pack_hooks" && echo "merge-gate: pre-merge-commit hook turned on (core.hooksPath = $pack_hooks)" >&2
}

case "${1:-}" in
  merge) shift; merge "$@" ;;
  check) check ;;
  install) install ;;
  *) usage ;;
esac
