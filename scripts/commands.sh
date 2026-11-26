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
#   create <change>          adds the worktree .worktrees/<change> on the branch of the change (flow.sh branch: <type>/<name>),
#                            from $BASE_BRANCH (main)
#   prepare <tree>           links the packs the main worktree installs without committing them (.awf/workflow-packs)
#                            into a fresh worktree, then runs deps <tree>
#   deps <dir>               installs the dependencies a fresh worktree lacks; the default does nothing
#   mounted                  prints the worktree the running stack serves; the default prints "n/a"
#   settings [--max-tasks N] [--max-total N]
#                            prints {"max_tasks":N,"max_total":N}: the option, else FLOW_MAX_TASKS, FLOW_MAX_TOTAL,
#                            else 1, 3; exit 2 on a value that is not an integer >= 1;
#                            in a Susan run (NEXUS_AGENT_RUN_ID set), max_tasks is always 1
#   merge <change>           merges the branch of the change into the main worktree through merge-gate.sh, aborted on failure
#   run-tasks <change> [--max-tasks N] [--max-total N] <task>...
#                            runs from the change worktree, which must have no uncommitted changes. Each task gets the
#                            sub-worktree .worktrees/<change>--<task> on branch <change branch>--<task>, reused when it
#                            exists, where apply-task runs (agent from FLOW_AGENT). At most --max-tasks run at once, and
#                            at most --max-total on the machine (one slot each). The sub-branches of the tasks that
#                            succeed are merged into the change branch in the order given; a conflict that only differs
#                            by checkboxes of tasks.md is resolved by keeping every checked box. A merged sub-worktree
#                            is removed, a failed one is kept for the next run. Writes .awf/status/run-tasks.json
#                            {"tasks":{"<task>":{"status":"done|failed","merged":bool}},"status":"done|failed"}, and
#                            the log of each task in .awf/status/run-tasks/<task>.log; exit 1 when a task is not merged.
#                            Parallel tasks always commit: their sub-branches carry the work to merge.
#   ask --run <id> --kind <decision|validation|failure-triage> --question <text> --options <a,b,...>
#       --recommended <option> --resume-step <step> --input <name>
#                            puts a question to a person for a run that then stops in its terminal state "waiting"; the
#                            answer comes back as `awf resume <id> --from <step> --input <name>=<answer>`. The default
#                            prints the question, the options and that resume line, prefixed with AWF_WORKFLOWS_PATH
#                            set to the pack's workflows (awf 0.11.9 does not find a pack workflow on resume)
#
# WORKTREE_BIN takes precedence over the declaration and the default.
# AWF_BIN replaces the awf binary that run-tasks starts. FLOW_WORKFLOW_PREFIX is put before apply-task; without it, the name in the pack's manifest.yaml followed by "/" when the pack has one (an installed
# pack, wherever it lives), otherwise nothing (workflows copied into the project).
#
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

op_create() {
  local change=${1:-} main branch tree
  check_change "$change"
  main=$(main_worktree)
  branch=$(bash "$here/flow.sh" branch "$change") || exit 2
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

# merge_subject <change>: "<type>(<name>):", the Conventional Commits prefix of the merge commits of a change.
merge_subject() {
  local typed
  typed=$(bash "$here/openspec-tasks.sh" branch "$1") || exit 2
  echo "${typed%%/*}(${typed#*/}):"
}

# merge_task <change> <task>: merges <change branch>--<task> into the current branch; exit 1, merge aborted, on failure.
merge_task() {
  local branch conflicts subject
  branch=$(git branch --show-current)--$2
  subject=$(merge_subject "$1") || return 1
  git merge -q --no-ff -m "$subject task $2" "$branch" >&2 && return 0
  conflicts=$(git diff --name-only --diff-filter=U)
  if [[ $conflicts == "openspec/changes/$1/tasks.md" ]] && union_checks "$conflicts"; then
    git commit -q --no-edit >&2 && return 0
  fi
  git merge --abort 2>/dev/null
  echo "The task $2 cannot be merged into $(git branch --show-current)${conflicts:+, conflict in: $(echo $conflicts)}." \
    "Its work is kept in .worktrees/$1--$2: merge $(git branch --show-current) there, resolve, commit, then run apply-change again." >&2
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
    branch=$(git branch --show-current)--$id
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
      git worktree remove --force "$main/.worktrees/$change--$id" >&2 && git branch -q -D "$(git branch --show-current)--$id" >&2
    fi
    [[ $merged == true ]] || ok=false
    json+="${json:+,}\"$id\":{\"status\":\"$result\",\"merged\":$merged}"
  done
  printf '{"tasks":{%s},"status":"%s"}\n' "$json" "$([[ $ok == true ]] && echo done || echo failed)" >"$top/.awf/status/run-tasks.json"
  cat "$top/.awf/status/run-tasks.json"
  [[ $ok == true ]]
}

op_settings() {
  local tasks=${FLOW_MAX_TASKS:-1} total=${FLOW_MAX_TOTAL:-3} pair
  while (($# > 0)); do
    case $1 in
      --max-tasks) tasks=${2:-} ;;
      --max-total) total=${2:-} ;;
      *) die 2 "Unknown setting \"$1\"." "Use --max-tasks or --max-total." ;;
    esac
    shift $(($# < 2 ? $# : 2))
  done
  for pair in "max-tasks (FLOW_MAX_TASKS):$tasks" "max-total (FLOW_MAX_TOTAL):$total"; do
    [[ ${pair##*:} =~ ^[1-9][0-9]*$ ]] ||
      die 2 "The setting ${pair%:*} is \"${pair##*:}\", which is not a whole number of 1 or more." "Give an integer of 1 or more."
  done
  # A Susan run (NEXUS_AGENT_RUN_ID set) creates no worktree: the tasks of a (parallel) group run one at a time in the clone.
  if [[ -n ${NEXUS_AGENT_RUN_ID:-} && $tasks != 1 ]]; then
    echo "Run mode: max-tasks $tasks lowered to 1, a run creates no sub-worktree." >&2
    tasks=1
  fi
  printf '{"max_tasks":%s,"max_total":%s}\n' "$tasks" "$total"
}

op_ask() {
  local run='' kind='' question='' options='' recommended='' step='' input=''
  while [[ $# -gt 0 ]]; do
    case $1 in
      --run) run=${2:-} ;;
      --kind) kind=${2:-} ;;
      --question) question=${2:-} ;;
      --options) options=${2:-} ;;
      --recommended) recommended=${2:-} ;;
      --resume-step) step=${2:-} ;;
      --input) input=${2:-} ;;
      *) die 2 "Unknown option \"$1\" of the operation ask." ;;
    esac
    shift 2 || die 2 "The option $1 of the operation ask needs a value."
  done
  [[ -n $run && -n $question && -n $step && -n $input ]] || die 2 "The operation ask needs --run, --question, --resume-step and --input."
  printf 'Question (%s): %s\n' "${kind:-decision}" "$question"
  if [[ -n $options ]]; then printf 'Options: %s%s\n' "${options//,/, }" "${recommended:+ (recommended: $recommended)}"; fi
  # ponytail: awf 0.11.9 resumes a pack workflow without its pack prefix and does not find it; AWF_WORKFLOWS_PATH
  # pointing at the pack's workflows works around it. Drop the prefix once awf resumes pack workflows.
  printf 'To answer: AWF_WORKFLOWS_PATH=%q awf resume %s --from %s --input %s=<answer>\n' "$(cd "$here/../workflows" && pwd)" "$run" "$step" "$input"
}

op_merge() {
  local change=${1:-}
  check_change "$change"
  local branch subject
  branch=$(bash "$here/flow.sh" branch "$change") || exit 2
  subject=$(merge_subject "$change") || exit 2
  cd "$(main_worktree)" || die 2 "The main worktree cannot be reached."
  bash "$here/merge-gate.sh" merge "$branch" "$subject merge change $change"
}

if [[ ${1:-} == --declared ]]; then
  [[ -n ${2:-} ]] && declared "$2" >/dev/null
  exit
fi

operation=${1:-}
shift || true

if [[ -n ${WORKTREE_BIN:-} ]]; then exec $WORKTREE_BIN "$operation" "$@"; fi
if command=$(declared "$operation"); then exec bash -c "$command \"\$@\"" commands.sh "$@"; fi

case $operation in
  create) op_create "$@" ;;
  prepare) [[ -n ${1:-} ]] || die 2 "The operation prepare needs the path of a worktree."; prepare_tree "$(main_worktree)" "$1" ;;
  deps) ;;
  mounted) echo n/a ;;
  settings) op_settings "$@" ;;
  merge) op_merge "$@" ;;
  run-tasks) op_run_tasks "$@" ;;
  ask) op_ask "$@" ;;
  *) die 2 "Unknown operation \"$operation\"." "Use create, prepare, deps, mounted, settings, merge, run-tasks or ask." ;;
esac
