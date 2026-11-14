#!/usr/bin/env bash
# Project command contract: commands.sh <operation> [arguments...]
#        commands.sh --declared <operation>   exit 0 when the project declares <operation>, 1 otherwise
#
# The pack calls no project tool directly. Every operation below has a default built on git. A project replaces one
# by declaring it in .awf/commands.yaml of the main worktree, one `operation: command` line each; a ` #` starts a
# comment. The arguments are appended to the declared command, which runs from the current directory. See
# examples/commands.yaml.
#
# Operations and their defaults:
#   create <change>          adds the worktree .worktrees/<change> on branch change/<change>, from $BASE_BRANCH (main)
#   deps <dir>               installs the dependencies a fresh worktree lacks; the default does nothing
#   mounted                  prints the worktree the running stack serves; the default prints "n/a"
#   settings [--max-changes N] [--max-tasks N] [--max-total N]
#                            prints {"max_changes":N,"max_tasks":N,"max_total":N}: the option, else FLOW_MAX_CHANGES,
#                            FLOW_MAX_TASKS, FLOW_MAX_TOTAL, else 2, 1, 3; exit 2 on a value that is not an integer >= 1
#   claim --run <id> --pid <pid> <change>...
#                            reserves the changes for one apply-many run, all or none; exit 1 when a live run holds one
#   release --run <id> <change>...
#                            frees the changes the run holds
#   verify <change>          exit 1 when the main worktree has uncommitted changes outside .awf/status and .worktrees
#   merge <change>           merges change/<change> into the main worktree through merge-gate.sh, aborted on failure
#   run-tasks <change> [--max-tasks N] [--max-total N] <task>...
#                            runs from the change worktree, which must have no uncommitted changes. Each task gets the
#                            sub-worktree .worktrees/<change>--<task> on branch change/<change>--<task>, reused when it
#                            exists, where apply-task runs (agent from FLOW_AGENT). At most --max-tasks run at once, and
#                            at most --max-total on the machine (one slot each). The sub-branches of the tasks that
#                            succeed are merged into the change branch in the order given; a conflict that only differs
#                            by checkboxes of tasks.md is resolved by keeping every checked box. A merged sub-worktree
#                            is removed, a failed one is kept for the next run. Writes .awf/status/run-tasks.json
#                            {"tasks":{"<task>":{"status":"done|failed","merged":bool}},"status":"done|failed"}, and
#                            the log of each task in .awf/status/run-tasks/<task>.log; exit 1 when a task is not merged.
#                            Parallel tasks always commit: their sub-branches carry the work to merge.
#   run-all [--max-changes N] [--max-tasks N] [--max-total N] <change>...
#                            runs apply-change in .worktrees/<change> for each change, at most --max-changes at once,
#                            log in .worktrees/<change>/.awf/status/run-all.log; exit 1 when one fails
#   e2e                      end-to-end tests on main: no default, exit 2 unless declared
#
# WORKTREE_BIN (every operation but e2e) and E2E_CMD (e2e) take precedence over the declaration and the default.
# AWF_BIN replaces the awf binary that run-tasks and run-all start. FLOW_WORKFLOW_PREFIX is put before apply-task and
# apply-change; without it, the name in the pack's manifest.yaml followed by "/" when the pack has one (an installed
# pack, wherever it lives), otherwise nothing (workflows copied into the project).
#
# Claims live in <git-common-dir>/awf/claims/<change>, shared by the main worktree and its worktrees, never tracked.
# Slots are flock(1) locks in FLOW_SLOTS_DIR, else $XDG_RUNTIME_DIR/flow-slots, else <git-common-dir>/awf/slots.
set -u

here=$(cd "$(dirname "$0")" && pwd)

die() { # die <code> <message>...
  local code=$1
  shift
  printf '%s\n' "$@" >&2
  exit "$code"
}

main_worktree() { git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'; }

# declared <operation>: prints the command .awf/commands.yaml of the main worktree declares for it.
declared() {
  local file
  file=$(main_worktree)/.awf/commands.yaml
  [[ -f $file ]] || return 1
  sed -n "s/^$1:[[:space:]]*//p" "$file" |
    sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/' | grep -m1 .
}

check_change() {
  [[ ${1:-} =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
    die 2 "The change name \"${1:-}\" is not in kebab-case." "Use lowercase letters, digits and hyphens, for example my-feature."
}

claims_dir() {
  local dir
  dir=$(cd "$(git rev-parse --git-common-dir)" && pwd)/awf/claims || die 2 "The git common directory cannot be found." "Run the command inside a git repository."
  mkdir -p "$dir" || die 2 "The directory $dir cannot be created."
  echo "$dir"
}

op_create() {
  local change=${1:-} main branch tree
  check_change "$change"
  main=$(main_worktree)
  branch=change/$change
  tree=$main/.worktrees/$change
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$main" worktree add -q "$tree" "$branch" >&2 || die 2 "The worktree $tree cannot be created on the existing branch $branch."
  else
    git -C "$main" worktree add -q -b "$branch" "$tree" "${BASE_BRANCH:-main}" >&2 ||
      die 2 "The worktree $tree cannot be created from ${BASE_BRANCH:-main}." "Check that this branch exists."
  fi
  prepare_tree "$main" "$tree" || die 2 "The worktree $tree cannot be prepared." "Run: commands.sh deps $tree"
  echo "$tree"
}

common_dir() { cd "$(git rev-parse --git-common-dir)" && pwd; }

# prepare_tree <main> <tree>: makes a fresh worktree usable. Packs installed in the main worktree without being
# committed (.awf/workflow-packs) are linked into it, and excluded from git so that no commit takes the link; then the
# project's deps operation runs.
prepare_tree() {
  local exclude
  if [[ -d $1/.awf/workflow-packs && ! -e $2/.awf/workflow-packs ]]; then
    exclude=$(common_dir)/info/exclude
    mkdir -p "$2/.awf" "${exclude%/*}" && ln -s "$1/.awf/workflow-packs" "$2/.awf/workflow-packs" || return 1
    grep -qxF /.awf/workflow-packs "$exclude" 2>/dev/null || echo /.awf/workflow-packs >>"$exclude"
  fi
  bash "$here/commands.sh" deps "$2" >&2
}

workflow_ref() { # workflow_ref <name>: the name awf run expects for a workflow of this pack
  local pack
  pack=$(cd "$here/.." && pwd)
  if [[ -n ${FLOW_WORKFLOW_PREFIX+set} ]]; then
    echo "$FLOW_WORKFLOW_PREFIX$1"
  elif [[ -f $pack/manifest.yaml ]]; then
    echo "$(sed -n 's/^name:[[:space:]]*["'\'']\{0,1\}\([^"'\'' ]*\).*/\1/p' "$pack/manifest.yaml" | head -n1)/$1"
  else
    echo "$1"
  fi
}

# acquire_slot <dir> <max_total>: holds fd 9 on one of the slots 1..max_total, waiting until one is free. The lock goes
# with the process, so a killed task frees its slot.
# ponytail: only run-tasks takes slots; sequential tasks of apply-change are not counted in max_total.
acquire_slot() {
  local i
  while :; do
    for ((i = 1; i <= $2; i++)); do
      exec 9>"$1/$i"
      flock -n 9 && return 0
      exec 9>&-
    done
    sleep 1
  done
}

# union_checks <file>: resolves a merge conflict on tasks.md when both sides differ only by checkboxes; every box
# checked on either side stays checked. Exit 1 when the sides differ otherwise.
union_checks() {
  local ours theirs merged
  ours=$(mktemp) theirs=$(mktemp) merged=$(mktemp)
  git show ":2:$1" >"$ours" && git show ":3:$1" >"$theirs" &&
    awk '
      function norm(s) { if (match(s, /^ *- \[[xX]\]/)) s = substr(s, 1, RLENGTH - 3) "[ ]" substr(s, RLENGTH + 1); return s }
      NR == FNR { t[FNR] = $0; n = FNR; next }
      { if (FNR > n || norm($0) != norm(t[FNR])) exit 1; print (t[FNR] ~ /^ *- \[[xX]\]/ ? t[FNR] : $0) }
      END { if (FNR != n) exit 1 }
    ' "$theirs" "$ours" >"$merged" &&
    cp "$merged" "$1" && git add -- "$1"
  local rc=$?
  rm -f "$ours" "$theirs" "$merged"
  return $rc
}

# merge_task <change> <task>: merges change/<change>--<task> into the current branch; exit 1, merge aborted, on failure.
merge_task() {
  local branch=change/$1--$2 conflicts
  git merge -q --no-ff -m "merge($1): task $2" "$branch" >&2 && return 0
  conflicts=$(git diff --name-only --diff-filter=U)
  if [[ $conflicts == "openspec/changes/$1/tasks.md" ]] && union_checks "$conflicts"; then
    git commit -q --no-edit >&2 && return 0
  fi
  git merge --abort 2>/dev/null
  echo "The task $2 cannot be merged into $(git branch --show-current)${conflicts:+, conflict in: $(echo $conflicts)}." \
    "Its work is kept in .worktrees/$1--$2: merge change/$1 there, resolve, commit, then run apply-change again." >&2
  return 1
}

# run_task <change> <task> <tree> <dir> <max_total>: applies one task in its sub-worktree; writes <dir>/<task>.result.
run_task() {
  local change=$1 id=$2 tree=$3 dir=$4 rc=0 status
  trap 'pkill -TERM -P $BASHPID 2>/dev/null; exit 143' TERM
  acquire_slot "$slots" "$5"
  (cd "$tree" && exec env -u OPENSPEC_ROOT "${AWF_BIN:-awf}" run "$(workflow_ref apply-task)" --output buffered \
    --input change="$change" --input task="$id" ${FLOW_AGENT:+--input agent="$FLOW_AGENT"}) >"$dir/$id.log" 2>&1 9>&- || rc=$?
  status=$(jq -r '.status // "failed"' "$tree/.awf/status/apply-task.json" 2>/dev/null) || status=failed
  if [[ $rc -eq 0 && $status == done ]]; then
    # A task box checked after the last slice commit would stay behind in the sub-worktree.
    if [[ -n $(git -C "$tree" status --porcelain -- . ':!.awf/status') ]]; then
      git -C "$tree" add -A -- . ':!.awf/status' && git -C "$tree" commit -q -m "chore($change): task $id" || status=failed
    fi
  else
    status=failed
  fi
  echo "$status" >"$dir/$id.result"
}

op_run_tasks() {
  local change=${1:-} max_tasks=${FLOW_MAX_TASKS:-1} max_total=${FLOW_MAX_TOTAL:-3} top main base dir id tree branch
  local pids=() ids=() json='' ok=true result merged
  check_change "$change"
  shift
  while [[ ${1:-} == --* ]]; do
    (($# >= 2)) || die 2 "The option $1 has no value."
    case $1 in --max-tasks) max_tasks=$2 ;; --max-total) max_total=$2 ;; *) die 2 "Unknown option \"$1\"." ;; esac
    shift 2
  done
  ids=("$@")
  ((${#ids[@]})) || die 2 "Usage: commands.sh run-tasks <change> [--max-tasks N] [--max-total N] <task>..."
  op_settings --max-tasks "$max_tasks" --max-total "$max_total" >/dev/null || exit 2
  command -v flock >/dev/null || die 2 "flock(1) is not installed: run-tasks cannot cap the tasks running on the machine." "Install util-linux, or declare run-tasks in .awf/commands.yaml."
  top=$(git rev-parse --show-toplevel) && cd "$top" || die 2 "Run run-tasks inside the change worktree."
  [[ -z $(git status --porcelain -- . ':!.awf/status' ':!.worktrees') ]] ||
    die 2 "The worktree $top has uncommitted changes: the parallel tasks would not see them." "Commit or discard them, then run again."
  slots=${FLOW_SLOTS_DIR:-${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/flow-slots}}
  slots=${slots:-$(common_dir)/awf/slots}
  mkdir -p "$slots" || die 2 "The slot directory $slots cannot be created." "Set FLOW_SLOTS_DIR to a writable directory."
  main=$(main_worktree)
  base=$(git rev-parse HEAD)
  dir=$top/.awf/status/run-tasks
  rm -rf "$dir" "$top/.awf/status/run-tasks.json"
  mkdir -p "$dir"
  trap 'kill "${pids[@]}" 2>/dev/null; wait; exit 143' TERM INT

  # Sub-worktrees are created one at a time: git locks its administrative files.
  for id in "${ids[@]}"; do
    tree=$main/.worktrees/$change--$id
    branch=change/$change--$id
    if [[ -d $tree ]]; then
      # A leftover directory that is not this worktree would let git walk up and commit on the main branch.
      if [[ $(git -C "$tree" symbolic-ref -q --short HEAD) != "$branch" ]]; then
        echo "The directory $tree is not the worktree of $branch: task $id is not run." "Remove it, then run again." >&2
        echo failed >"$dir/$id.result"
        continue
      fi
      echo "Resuming the existing sub-worktree of task $id." >&2
      # Done earlier but not merged (a conflict since resolved there): straight to the merge.
      if grep -q "^- \[x\] ${id//./\\.} " "$tree/openspec/changes/$change/tasks.md" 2>/dev/null &&
        [[ -z $(git -C "$tree" status --porcelain -- . ':!.awf/status') ]]; then
        echo done >"$dir/$id.result"
        continue
      fi
    elif ! { if git show-ref --verify --quiet "refs/heads/$branch"; then git worktree add -q "$tree" "$branch"; else git worktree add -q -b "$branch" "$tree" "$base"; fi; } >&2 ||
      ! prepare_tree "$main" "$tree"; then
      echo failed >"$dir/$id.result"
      continue
    fi
    while (($(jobs -rp | wc -l) >= max_tasks)); do wait -n; done
    run_task "$change" "$id" "$tree" "$dir" "$max_total" &
    pids+=($!)
  done
  wait

  for id in "${ids[@]}"; do
    result=$(cat "$dir/$id.result" 2>/dev/null || echo failed)
    merged=false
    if [[ $result == done ]] && merge_task "$change" "$id"; then
      merged=true
      git worktree remove --force "$main/.worktrees/$change--$id" >&2 && git branch -q -D "change/$change--$id" >&2
    fi
    [[ $merged == true ]] || ok=false
    json+="${json:+,}\"$id\":{\"status\":\"$result\",\"merged\":$merged}"
  done
  printf '{"tasks":{%s},"status":"%s"}\n' "$json" "$([[ $ok == true ]] && echo done || echo failed)" >"$top/.awf/status/run-tasks.json"
  cat "$top/.awf/status/run-tasks.json"
  [[ $ok == true ]]
}

op_run_all() {
  local changes='' tasks='' total='' settings main change tree rc=0 pids=() names=() i
  while [[ ${1:-} == --* ]]; do
    (($# >= 2)) || die 2 "The option $1 has no value."
    case $1 in --max-changes) changes=$2 ;; --max-tasks) tasks=$2 ;; --max-total) total=$2 ;; *) die 2 "Unknown option \"$1\"." ;; esac
    shift 2
  done
  (($#)) || die 2 "Usage: commands.sh run-all [--max-changes N] [--max-tasks N] [--max-total N] <change>..."
  settings=$(op_settings ${changes:+--max-changes "$changes"} ${tasks:+--max-tasks "$tasks"} ${total:+--max-total "$total"}) || exit 2
  changes=$(jq -r .max_changes <<<"$settings")
  main=$(main_worktree)
  trap 'kill "${pids[@]}" 2>/dev/null; wait; exit 143' TERM INT
  for change in "$@"; do
    check_change "$change"
    tree=$main/.worktrees/$change
    [[ -d $tree ]] || { echo "The worktree $tree does not exist: $change is not applied." >&2; rc=1; continue; }
    while (($(jobs -rp | wc -l) >= changes)); do wait -n; done
    mkdir -p "$tree/.awf/status"
    (cd "$tree" && exec env -u OPENSPEC_ROOT "${AWF_BIN:-awf}" run "$(workflow_ref apply-change)" --output buffered --input change="$change" \
      ${tasks:+--input max_tasks="$tasks"} ${total:+--input max_total="$total"}) >"$tree/.awf/status/run-all.log" 2>&1 &
    pids+=($!)
    names+=("$change")
  done
  for i in "${!pids[@]}"; do
    wait "${pids[$i]}" || { echo "apply-change failed for ${names[$i]}: see .worktrees/${names[$i]}/.awf/status/run-all.log" >&2; rc=1; }
  done
  return $rc
}

op_settings() {
  local changes=${FLOW_MAX_CHANGES:-2} tasks=${FLOW_MAX_TASKS:-1} total=${FLOW_MAX_TOTAL:-3} pair
  while (($# > 0)); do
    case $1 in
      --max-changes) changes=${2:-} ;;
      --max-tasks) tasks=${2:-} ;;
      --max-total) total=${2:-} ;;
      *) die 2 "Unknown setting \"$1\"." "Use --max-changes, --max-tasks or --max-total." ;;
    esac
    shift $(($# < 2 ? $# : 2))
  done
  for pair in "max-changes (FLOW_MAX_CHANGES):$changes" "max-tasks (FLOW_MAX_TASKS):$tasks" "max-total (FLOW_MAX_TOTAL):$total"; do
    [[ ${pair##*:} =~ ^[1-9][0-9]*$ ]] ||
      die 2 "The setting ${pair%:*} is \"${pair##*:}\", which is not a whole number of 1 or more." "Give an integer of 1 or more."
  done
  printf '{"max_changes":%s,"max_tasks":%s,"max_total":%s}\n' "$changes" "$tasks" "$total"
}

op_claim() {
  local run='' pid='' dir change file held taken=()
  while [[ ${1:-} == --* ]]; do
    (($# >= 2)) || die 2 "The option $1 has no value."
    case $1 in --run) run=$2 ;; --pid) pid=$2 ;; *) die 2 "Unknown option \"$1\"." ;; esac
    shift 2
  done
  [[ -n $run && $pid =~ ^[0-9]+$ && $# -gt 0 ]] || die 2 "Usage: commands.sh claim --run <id> --pid <pid> <change>..."
  dir=$(claims_dir) || exit $?
  for change in "$@"; do
    check_change "$change"
    file=$dir/$change
    # A claim whose process has ended is stale: it is removed, then taken.
    if [[ -f $file ]]; then
      read -r held _ <"$file"
      [[ $held == "$run" ]] && continue
      kill -0 "$(awk '{print $2}' "$file")" 2>/dev/null || rm -f "$file"
    fi
    if (set -C && printf '%s %s\n' "$run" "$pid" >"$file") 2>/dev/null; then
      taken+=("$file")
    else
      ((${#taken[@]})) && rm -f "${taken[@]}"
      die 1 "Another apply-many run is applying the change $change." "Wait for it to finish, or choose another change."
    fi
  done
}

op_release() {
  local run='' dir change held
  [[ ${1:-} == --run && $# -ge 2 ]] && { run=$2; shift 2; }
  [[ -n $run ]] || die 2 "Usage: commands.sh release --run <id> <change>..."
  dir=$(claims_dir) || exit $?
  for change in "$@"; do
    [[ -f $dir/$change ]] || continue
    read -r held _ <"$dir/$change"
    [[ $held == "$run" ]] && rm -f "$dir/$change"
  done
  return 0
}

op_verify() {
  local change=${1:-} main dirty
  check_change "$change"
  main=$(main_worktree)
  dirty=$(git -C "$main" status --porcelain -- . ':!.awf/status' ':!.worktrees') || die 2 "git status fails in $main."
  [[ -z $dirty ]] || die 1 "The main worktree $main has changed while $change was applied:" "$dirty"
}

op_merge() {
  local change=${1:-}
  check_change "$change"
  cd "$(main_worktree)" || die 2 "The main worktree cannot be reached."
  bash "$here/merge-gate.sh" merge "change/$change" "merge($change): apply change $change"
}

if [[ ${1:-} == --declared ]]; then
  [[ -n ${2:-} ]] && declared "$2" >/dev/null
  exit
fi

operation=${1:-}
shift || true

if [[ $operation == e2e && -n ${E2E_CMD:-} ]]; then exec bash -c "$E2E_CMD"; fi
if [[ $operation != e2e && -n ${WORKTREE_BIN:-} ]]; then exec $WORKTREE_BIN "$operation" "$@"; fi
if command=$(declared "$operation"); then exec bash -c "$command \"\$@\"" commands.sh "$@"; fi

case $operation in
  create) op_create "$@" ;;
  deps) ;;
  mounted) echo n/a ;;
  settings) op_settings "$@" ;;
  claim) op_claim "$@" ;;
  release) op_release "$@" ;;
  verify) op_verify "$@" ;;
  merge) op_merge "$@" ;;
  run-tasks) op_run_tasks "$@" ;;
  run-all) op_run_all "$@" ;;
  e2e) die 2 "The operation e2e has no default." "Declare it in .awf/commands.yaml, for example: e2e: <command>" ;;
  *) die 2 "Unknown operation \"$operation\"." "Use create, deps, mounted, settings, claim, release, verify, merge, run-tasks, run-all or e2e." ;;
esac
