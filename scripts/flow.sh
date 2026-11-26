#!/usr/bin/env bash
# Unit computations of the flow-*.yaml workflows: flow.sh <subcommand> [arguments]
# Each subcommand makes one computation and returns an exit code; the sequence lives in the workflows.
#
# init <propose|update|sync|archive|accept> <change>   checks the input, creates or reuses .worktrees/propose-<change>
#                                                  (archive and accept need an existing change); in run mode, switches
#                                                  the clone to docs/propose-<change> instead (see below)
# switch <branch>                                  run mode only: switches the clone to <branch>, local or from origin,
#                                                  else created from $BASE_BRANCH (main)
#
# Run mode: NEXUS_AGENT_RUN_ID set means the workflow runs in a Susan run, a fresh clone of the project with all its
# branches, positioned on main, discarded at the end; the run pushes the current branch (never main). In that mode no
# worktree is created: init switches the clone to the branch and the workflow goes on; merge does not merge into main
# (a person does, through a pull request or flow-accept outside a run).
# init-agent <name> <task>                         creates or reuses the worktree .worktrees/<name>-<task> of the main
#                                                  worktree, on branch agent/<name>-<task> (from $BASE_BRANCH, main by
#                                                  default), and writes its path to .awf/status/agent-worktree/
#                                                  <name>-<task>.json of the main worktree;
#                                                  2 when a name is not in kebab-case, or when the worktree exists with
#                                                  uncommitted changes (untracked files included) unless AGENT_REPRISE=1
#
# gate scope <propose|update|sync|archive|accept> <change>   30 when git status leaves the command's write scope
# gate explore                                     30 when a file under openspec/ changed
# gate validation <change>                         30 when "openspec validate <change> --strict" fails
# gate deltas <change>                             30 when a requirement of a delta is longer than 500 characters
# gate synced <change>                             30 when openspec/specs/ misses an ADDED, MODIFIED or RENAMED
#                                                  requirement of a delta, or still holds a REMOVED one
# gate dod <change>                                30 when the Definition of Done section of tasks.md cannot be read
# gate manual <change>                             30 when a criterion or an open manual task has neither a "Verified by"
#                                                  command nor the "Manual" mention
# gate levels <change>                             30 when an open slice of a language with `levels` declares no test level
# gate open <change>                               2 when tasks.md still has an open box (task or criterion): no archive
# gate replay <change>                             30 when the command of a Definition of Done criterion fails on replay
#                                                  (boxes ignored); run by flow-archive
# gate archive <change>                            30 when the change is not under openspec/changes/archive/ or the strict
#                                                  validation of the specs fails
#
# accept <change>                                  writes openspec/changes/<change>/acceptance.yaml (reviewer, date,
#                                                  fingerprint of the Definition of Done, commit)
# branch <change>                                  prints the code branch of the change: <type>/<name> for a change named
#                                                  <type>-<name>, feat/<change> otherwise; change/<change> while only
#                                                  that branch from before 0.11 exists
# merge <change>                                   merges docs/propose-<change> into the main branch (merge commit, no
#                                                  push), in the worktree that has main checked out; 2 from an agent step or without one
# commit <propose|update|sync|archive|accept> <change>   commits the current worktree; nothing to commit returns 0
# report <command> <change> <phase> <attempts> <status> [waived gate]...
#                                                  writes .awf/status/flow-<command>.json and returns the phase's code
#                                                  phases: input, agent, gate, merge, commit, done; statuses: success, failed
# waive <change> <gate> --reason <reason> [--days N]
#                                                  2 from an agent step; adds a waiver to <git-common-dir>/awf/waivers.yaml and a grant line to
#                                                  waivers.log; the reason is required, N from 1 to 30 (30 by default)
# waived <change> <gate>                           0 and a "use" line in the log when a valid waiver exists; 30 otherwise,
#                                                  expired ones included
# context                                         prints the changes in progress, the worktrees, the mounted worktree and
#                                                  the valid waivers
# fingerprint <save|check>                         records then compares the fingerprint of waivers.yaml and waivers.log;
#                                                  30 when one of them changed
# migrate                                         moves .awf/waivers.yaml and .awf/waivers.log, when they are tracked, to
#                                                  <git-common-dir>/awf/ (appended to the target file), then removes them
#                                                  from git; with no tracked file, returns 0
#
# The waiver registry lives outside the working tree, in <git-common-dir>/awf/: shared by the main worktree and its
# worktrees, never tracked. The gates read git status of the current directory: run them in the worktree.
#
# Exit codes: 0 success, 2 invalid input, 3 agent, 30 gate.
set -u

die() { # die <code> <message>...
  local code=$1
  shift
  printf '%s\n' "$@" >&2
  exit "$code"
}

registry_dir() { # registry_dir: absolute directory <git-common-dir>/awf, created on demand
  local dir
  dir=$(cd "$(git rev-parse --git-common-dir)" && pwd)/awf || die 2 "The git common directory cannot be found." "Run the command inside a git repository."
  mkdir -p "$dir" || die 2 "The directory $dir cannot be created."
  echo "$dir"
}

changes_in() { # changes_in <root>: names of the changes in progress (archive excluded)
  local d
  for d in "$1"/openspec/changes/*/; do
    [[ -d $d ]] || continue
    d=${d%/}
    [[ ${d##*/} == archive ]] || echo "${d##*/}"
  done
}

check_change() {
  [[ $1 =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
    die 2 "The change name \"$1\" is not in kebab-case." "Use lowercase letters, digits and hyphens, for example my-feature."
}

run_mode() { # run_mode: 0 inside a Susan run (NEXUS_AGENT_RUN_ID set): a fresh clone, no worktree, nobody to run again
  [[ -n ${NEXUS_AGENT_RUN_ID:-} ]]
}

switch_branch() { # switch_branch <branch>: the clone moves to <branch>, local or from origin, else created from the base
  local branch=$1 base=${BASE_BRANCH:-main}
  if [[ $(git branch --show-current) == "$branch" ]]; then
    echo "Run mode: branch $branch already checked out."
    return
  fi
  if git show-ref --verify --quiet "refs/heads/$branch" || git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git switch -q "$branch" >&2 ||
      die 2 "Run mode: the switch to branch $branch failed." \
        "The clone has uncommitted changes that the switch would overwrite: see the git message above."
  else
    git switch -q -c "$branch" "$base" >&2 ||
      die 2 "Run mode: branch $branch cannot be created from $base." "Check that $base exists in the clone."
  fi
  echo "Run mode: branch $branch checked out in the clone (no worktree)."
}

has_branch() { git show-ref --verify --quiet "refs/heads/$1" || git show-ref --verify --quiet "refs/remotes/origin/$1"; }

# change_branch <change>: the code branch of the change, <type>/<name> from the type its name starts with
# (feat/<change> without type); a change/<change> branch from before 0.11 is kept while the typed one does not exist.
change_branch() {
  local change=${1:-} typed
  check_change "$change"
  typed=$(bash "$(dirname "$0")/openspec-tasks.sh" branch "$change") || exit 2
  if ! has_branch "$typed" && has_branch "change/$change"; then echo "change/$change"; else echo "$typed"; fi
}

switch() { # switch <branch>: run mode only, the clone moves to <branch> (see switch_branch)
  local branch=${1:-}
  [[ $branch =~ ^[a-z]+/[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
    die 2 "The branch name \"$branch\" is not valid." "Give a branch such as feat/my-feature or docs/propose-feat-my-feature."
  run_mode || die 2 "The switch subcommand only runs in a Susan run (NEXUS_AGENT_RUN_ID set)." "Outside a run, the workflows use a worktree."
  switch_branch "$branch"
}

init() {
  local command=${1:-} change=${2:-}
  case $command in
    propose | update | sync | archive | accept) ;;
    *) die 2 "Unknown command \"$command\"." "The commands with a worktree are propose, update, sync, archive and accept." ;;
  esac
  check_change "$change"

  local branch=docs/propose-$change tree=.worktrees/propose-$change
  # A new change starts with its type (feat-, fix-...), checked before any switch; a change drafted before 0.11 keeps
  # its name, and an existing one gets the "already exists" message below.
  if [[ $command == propose && ! -d openspec/changes/$change ]] && ! has_branch "$branch"; then
    bash "$(dirname "$0")/openspec-tasks.sh" check-name "$change" >&2 || exit 2
  fi
  # In a run, the clone itself moves to the branch: the checks below then read the change on that branch.
  if run_mode; then
    switch_branch "$branch"
    tree=.
  fi
  local known=0
  [[ -d openspec/changes/$change || -d $tree/openspec/changes/$change ]] && known=1

  if [[ $command == propose && $known == 1 ]]; then
    die 2 "The change \"$change\" already exists." "To revise it, run /flow:update $change."
  fi
  if [[ $command != propose && $known == 0 ]]; then
    local available
    available=$(
      changes_in .
      changes_in "$tree"
    )
    die 2 "The change \"$change\" is not in openspec/changes." \
      "Available changes: ${available//$'\n'/ }" \
      "To create it, run /flow:propose $change."
  fi
  run_mode && return

  if [[ -e $tree/.git ]]; then
    echo "Worktree reused: $tree"
  elif git show-ref --verify --quiet "refs/heads/$branch"; then
    git worktree add -q "$tree" "$branch" >&2 || die 2 "The worktree $tree cannot be created on the existing branch $branch."
    echo "Worktree created: $tree"
  else
    git worktree add -q -b "$branch" "$tree" "${BASE_BRANCH:-main}" >&2 ||
      die 2 "The worktree $tree cannot be created from ${BASE_BRANCH:-main}." "Check that this branch exists."
    echo "Worktree created: $tree"
  fi
}

init_agent() {
  local name=${1:-} task=${2:-} main branch tree
  check_change "$name"
  check_change "$task"
  main=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
  [[ -n $main ]] || die 2 "The main worktree cannot be found." "Run the command inside a git repository."
  branch=agent/$name-$task
  tree=$main/.worktrees/$name-$task
  if [[ -e $tree/.git ]]; then
    if [[ -n $(git -C "$tree" status --porcelain) && ${AGENT_REPRISE:-} != 1 ]]; then
      die 2 "The worktree $tree has uncommitted changes, so it is not reused." \
        "Commit or remove them, or run again with AGENT_REPRISE=1 to resume the work in progress."
    fi
    echo "Worktree reused: $tree"
  else
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$main" worktree add -q "$tree" "$branch" >&2 || die 2 "The worktree $tree cannot be created on the existing branch $branch."
    else
      git -C "$main" worktree add -q -b "$branch" "$tree" "${BASE_BRANCH:-main}" >&2 ||
        die 2 "The worktree $tree cannot be created from ${BASE_BRANCH:-main}." "Check that this branch exists."
    fi
    bash "$(dirname "$0")/commands.sh" prepare "$tree" >&2 || die 2 "The worktree $tree cannot be prepared." "Run: commands.sh prepare $tree"
    echo "Worktree created: $tree"
  fi
  local report=$main/.awf/status/agent-worktree/$name-$task.json
  mkdir -p "${report%/*}" &&
    printf '{"name":"%s","task":"%s","branch":"%s","worktree":"%s"}\n' "$name" "$task" "$branch" "$tree" >"$report" ||
    die 2 "The report $report cannot be written."
}

changed_files() { # changed_files: one changed, deleted or untracked path per line (origin of a rename included)
  local entry
  while IFS= read -r -d '' entry; do
    echo "${entry:3}"
    if [[ ${entry:0:1} == [RC] || ${entry:1:1} == [RC] ]]; then
      IFS= read -r -d '' entry && echo "$entry"
    fi
  done < <(git status --porcelain -z --untracked-files=all)
}

reject_files() { # reject_files <message> <file>...: names the rejected files and exits with 30
  local message=$1
  shift
  die 30 "$message" "$(printf '  %s\n' "$@")"
}

gate_scope() {
  local command=${1:-} change=${2:-} allowed file
  case $command in
    propose | update) allowed=openspec/changes/$change/ ;;
    sync) allowed=openspec/specs/ ;;
    archive) allowed=openspec/ ;;
    accept) allowed=openspec/changes/$change/ ;;
    *) die 2 "Unknown command \"$command\"." "The drafting commands are propose, update, sync, archive and accept." ;;
  esac
  check_change "$change"

  local outside=()
  while IFS= read -r file; do
    [[ $file == "$allowed"* ]] || outside+=("$file")
  done < <(changed_files)
  ((${#outside[@]} == 0)) ||
    reject_files "Files changed outside the scope of $command ($allowed):" "${outside[@]}"
}

gate_explore() {
  local outside=() file
  while IFS= read -r file; do
    [[ $file == openspec/* ]] && outside+=("$file")
  done < <(changed_files)
  ((${#outside[@]} == 0)) ||
    reject_files "Exploring writes nothing in openspec/. Changed files:" "${outside[@]}"
}

gate_tool() { # gate_tool <title> <command>...: returns the raw output of the command, or exits with 30
  local title=$1 output
  shift
  output=$("$@" 2>&1) || die 30 "$title" "$output"
}

gate_open() {
  local change=${1:-} tasks open
  tasks=openspec/changes/$change/tasks.md
  [[ -f $tasks ]] || die 2 "The file $tasks cannot be found." "Run the command in the change's worktree."
  open=$(grep -E '^- \[ \] ' "$tasks")
  [[ -z $open ]] ||
    die 2 "The change $change still has open boxes in tasks.md:" "$open" "Finish them with /flow:apply $change, then archive again."
}

gate_archive() {
  local change=${1:-}
  local archived=(openspec/changes/archive/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-"$change")
  [[ -d ${archived[0]} ]] || die 30 "The change $change is not under openspec/changes/archive/." "The archive did not move its directory."
  [[ ! -e openspec/changes/$change ]] || die 30 "The directory openspec/changes/$change still exists after the archive."
  gate_tool "The strict validation of the main specs fails:" openspec validate --specs --strict
}

gate() {
  local name=${1:-}
  shift || true
  case $name in
    scope) gate_scope "$@" ;;
    explore) gate_explore ;;
    validation) gate_tool "The strict validation of ${1:-?} fails:" openspec validate "${1:-}" --strict ;;
    deltas) gate_tool "A delta of ${1:-?} is longer than allowed:" bash "$(dirname "$0")/openspec-tasks.sh" check-deltas "${1:-}" ;;
    synced) gate_tool "The main specs do not carry the deltas of ${1:-?}:" bash "$(dirname "$0")/openspec-tasks.sh" check-synced "${1:-}" ;;
    dod) gate_tool "The Definition of Done of ${1:-?} cannot be read:" bash "$(dirname "$0")/openspec-tasks.sh" dod "${1:-}" ;;
    manual) gate_tool "A criterion or a manual task of ${1:-?} has no command and no \"Manual\" mention:" bash "$(dirname "$0")/openspec-tasks.sh" check-manual "${1:-}" ;;
    levels) gate_tool "A slice of ${1:-?} declares no test level:" bash "$(dirname "$0")/openspec-tasks.sh" check-levels "${1:-}" ;;
    open) gate_open "$@" ;;
    replay) gate_tool "The replay of the Definition of Done of ${1:-?} fails:" bash "$(dirname "$0")/openspec-tasks.sh" verify-dod "${1:-}" --replay ;;
    archive) gate_archive "$@" ;;
    *) die 2 "Unknown gate \"$name\"." "The unit gates are scope, explore, validation, deltas, synced, dod, manual, levels, open, replay and archive." ;;
  esac
}

commit() {
  local command=${1:-} change=${2:-} message
  case $command in
    propose) message="propose change $change" ;;
    update) message="update change $change" ;;
    sync) message="sync the specs of change $change" ;;
    archive) message="archive change $change" ;;
    accept) message="accept change $change" ;;
    *) die 2 "Unknown command \"$command\"." "The commands that commit are propose, update, sync, archive and accept." ;;
  esac
  check_change "$change"

  git add -A || die 30 "Staging the files failed."
  if git diff --cached --quiet; then
    echo "Nothing to commit."
    return 0
  fi
  git commit -q -m "docs(openspec): $message" || die 30 "The commit failed."
}

report() {
  local command=${1:-} change=${2:-} phase=${3:-} attempts=${4:-} status=${5:-}
  shift $(($# < 5 ? $# : 5))
  case $command in
    propose | update | sync | archive | accept | apply) ;;
    *) die 2 "Unknown command \"$command\"." ;;
  esac
  [[ $change =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die 2 "The change name \"$change\" is not in kebab-case."
  [[ $attempts =~ ^[0-9]+$ ]] || die 2 "The number of attempts \"$attempts\" is not an integer."
  case $phase in
    input | agent | gate | merge | commit | done) ;;
    *) die 2 "Unknown phase \"$phase\"." "The phases are input, agent, gate, merge, commit and done." ;;
  esac
  case $status in
    success) ;;
    failed) [[ $phase == input || $phase == agent || $phase == gate || $phase == merge ]] ||
      die 2 "A failure belongs to the input, agent, gate or merge phase, not to \"$phase\"." ;;
    *) die 2 "Unknown status \"$status\"." "The statuses are success and failed." ;;
  esac
  local waived='' gate
  for gate in "$@"; do
    [[ $gate =~ ^[a-z]+$ ]] || die 2 "The waived gate \"$gate\" is not valid."
    waived+="${waived:+, }\"$gate\""
  done

  mkdir -p .awf/status
  printf '{\n  "command": "%s",\n  "change": "%s",\n  "phase": "%s",\n  "attempts": %s,\n  "waived": [%s],\n  "status": "%s"\n}\n' \
    "$command" "$change" "$phase" "$((10#$attempts))" "$waived" "$status" >".awf/status/flow-$command.json"

  case $status:$phase in
    success:*) return 0 ;;
    failed:input) return 2 ;;
    failed:agent) return 3 ;;
    failed:gate | failed:merge) return 30 ;;
  esac
}

# Acceptance, merge and waivers are your decisions: an agent step does not trigger them. A session started by an agent
# step (claude -p) gets CLAUDE_CODE_SESSION_ATTENDED=0; AWF_AGENT_STEP, set by hand, plays the same part.
reject_agent() { # reject_agent <what> <workflow>
  [[ -z ${AWF_AGENT_STEP:-} && ${CLAUDE_CODE_SESSION_ATTENDED:-1} != 0 ]] || die 2 "$1 runs from your terminal, not from an agent step." "Run $2 yourself."
}

accept() {
  local change=${1:-} reviewer fingerprint
  check_change "$change"
  reject_agent "Acceptance" flow-accept
  [[ -f openspec/changes/$change/tasks.md ]] || die 2 "The change $change is not in openspec/changes." "Run the command in the change's worktree."
  reviewer=$(git config user.name) && [[ -n $reviewer ]] || die 2 "The reviewer is unknown." "Set it with git config user.name."
  fingerprint=$(bash "$(dirname "$0")/openspec-tasks.sh" dod-fingerprint "$change") ||
    die 30 "The fingerprint of the Definition of Done of $change cannot be computed."
  reviewer=${reviewer//\\/\\\\}
  reviewer=${reviewer//\"/\\\"}
  printf 'reviewer: "%s"\ndate: %s\nfingerprint: %s\ncommit: %s\n' \
    "$reviewer" "$(date -u +%F)" "$fingerprint" "$(git rev-parse HEAD)" >"openspec/changes/$change/acceptance.yaml"
  echo "Acceptance written: openspec/changes/$change/acceptance.yaml"
}

merge() {
  local change=${1:-} branch base=${BASE_BRANCH:-main}
  check_change "$change"
  if run_mode; then
    # A run never pushes the main branch: merging into it here would be lost. The run pushes docs/propose-<change>.
    echo "Run mode: docs/propose-$change is not merged into $base. The run pushes the branch; a person merges it" \
      "(pull request on the forge, or flow-accept run outside a run)."
    return
  fi
  reject_agent "The merge" flow-accept
  branch=docs/propose-$change
  git show-ref --verify --quiet "refs/heads/$branch" || die 2 "The branch $branch does not exist." "Run /flow:propose $change first."
  local gate rc=0 step here
  here=$(cd "$(dirname "$0")" && pwd)
  # merge-gate.sh merges in the worktree that has $base checked out, and exits 2 when there is none.
  gate=$(bash "$here/merge-gate.sh" merge "$branch" "docs($(bash "$here/openspec-tasks.sh" branch "$change" | cut -d/ -f2-)): accept change $change" 2>&1) || rc=$?
  [[ -n $gate ]] && printf '%s\n' "$gate" >&2
  if ((rc != 0)); then
    [[ $gate == *"no worktree has branch $base checked out"* ]] && exit 2
    step=$(sed -n "s/^merge-gate: step \([A-Z0-9_]*\) failed.*/\1/p" <<<"$gate" | head -n1)
    [[ -n $step ]] &&
      die 30 "The merge gate stopped $branch: step $step failed. $base is unchanged." "Fix step $step in the worktree, then run again."
    die 30 "The merge of $branch into $base failed and was aborted." "Resolve the conflict in the worktree, then run again."
  fi
  echo "Branch $branch merged into $base."
}

check_gate() {
  [[ $1 =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
    die 2 "The gate \"$1\" is not valid." "Use the gate name in kebab-case, for example review-ts."
}

waive() {
  local change=${1:-} gate=${2:-} reason='' days=30 has_reason=0
  shift $(($# < 2 ? $# : 2))
  while (($# > 0)); do
    case $1 in
      --reason)
        reason=${2:-}
        has_reason=1
        shift $(($# < 2 ? $# : 2))
        ;;
      --days)
        days=${2:-}
        shift $(($# < 2 ? $# : 2))
        ;;
      *) die 2 "Unknown argument \"$1\"." "Syntax: flow.sh waive <change> <gate> --reason <reason> [--days N]." ;;
    esac
  done
  check_change "$change"
  check_gate "$gate"
  reject_agent "A waiver" flow-waive
  [[ $has_reason == 1 && $reason == *[![:space:]]* ]] ||
    die 2 "The reason for the waiver is required." "Add --reason \"<reason>\" to say why the gate is waived."
  [[ $reason != *$'\n'* && $reason != *$'\r'* ]] || die 2 "The reason must fit on one line."
  [[ $days =~ ^[0-9]+$ ]] && ((10#$days >= 1)) ||
    die 2 "The duration \"$days\" is not a whole number of days above 0."
  ((10#$days <= 30)) ||
    die 2 "A waiver lasts 30 days at most, and --days can only shorten it." "Requested: $days days."
  days=$((10#$days))
  local author
  author=$(git config user.name) && [[ -n $author ]] ||
    die 2 "The author of the waiver is unknown." "Set it with git config user.name."

  local granted expires stamp q_reason q_author
  granted=$(date -u +%F)
  expires=$(date -u -d "$granted +$days days" +%F)
  stamp=$(date -u +%FT%TZ)
  q_reason=${reason//\\/\\\\}
  q_reason=${q_reason//\"/\\\"}
  q_author=${author//\\/\\\\}
  q_author=${q_author//\"/\\\"}
  local dir
  dir=$(registry_dir) || exit $?
  printf -- '- {change: %s, gate: %s, reason: "%s", author: "%s", granted: %s, expires: %s}\n' \
    "$change" "$gate" "$q_reason" "$q_author" "$granted" "$expires" >>"$dir/waivers.yaml"
  printf '%s grant %s %s %s expires %s %s\n' "$stamp" "$change" "$gate" "$author" "$expires" "$reason" >>"$dir/waivers.log"
  echo "Waiver granted to $change for gate $gate until $expires."
}

waived() {
  local change=${1:-} gate=${2:-}
  check_change "$change"
  check_gate "$gate"

  # The change and the gate open the line, the expiry closes it: a reason that imitates a line changes nothing.
  local today line author='' expires='' expired=0 pattern dir
  dir=$(registry_dir) || exit $?
  today=$(date -u +%F)
  pattern="^- \{change: $change, gate: $gate, reason: \".*\", author: \"(.*)\", granted: [0-9-]{10}, expires: ([0-9]{4}-[0-9]{2}-[0-9]{2})\}\$"
  if [[ -f $dir/waivers.yaml ]]; then
    while IFS= read -r line; do
      [[ $line =~ $pattern ]] || continue
      if [[ ${BASH_REMATCH[2]} < $today ]]; then
        expired=1
      else
        author=${BASH_REMATCH[1]} expires=${BASH_REMATCH[2]}
        break
      fi
    done <"$dir/waivers.yaml"
  fi

  if [[ -z $author ]]; then
    ((expired == 1)) && die 30 "The waiver of $change for gate $gate has expired." "To renew it, run /flow:waive $change $gate --reason \"<reason>\"."
    die 30 "No waiver for $change on gate $gate." "To ask for one, run /flow:waive $change $gate --reason \"<reason>\"."
  fi
  printf '%s use %s %s %s\n' "$(date -u +%FT%TZ)" "$change" "$gate" "$author" >>"$dir/waivers.log"
  echo "Gate $gate waived for $change by $author until $expires (waiver in $dir/waivers.yaml)."
}

# Fingerprint of the waiver registry and its log, compared before and after an agent step.
fingerprint() {
  local mode=${1:-} saved=.awf/status/registry.sha256 file dir
  dir=$(registry_dir) || exit $?
  case $mode in
    save)
      mkdir -p .awf/status
      for file in "$dir/waivers.yaml" "$dir/waivers.log"; do
        if [[ -f $file ]]; then echo "$(sha256sum <"$file" | cut -d' ' -f1) $file"; else echo "absent $file"; fi
      done >"$saved"
      ;;
    check)
      [[ -f $saved ]] || die 2 "No fingerprint recorded." "Run flow.sh fingerprint save before the agent step."
      local changed=() before
      for file in "$dir/waivers.yaml" "$dir/waivers.log"; do
        before=$(grep -F " $file" "$saved" | cut -d' ' -f1)
        if [[ -f $file ]]; then [[ $(sha256sum <"$file" | cut -d' ' -f1) == "$before" ]] || changed+=("$file"); else [[ $before == absent ]] || changed+=("$file"); fi
      done
      ((${#changed[@]} == 0)) || reject_files "The agent step changed the waiver registry:" "${changed[@]}"
      ;;
    *) die 2 "Unknown mode \"$mode\"." "Syntax: flow.sh fingerprint <save|check>." ;;
  esac
}

migrate() { # migrate: one-off move from the former tracked location to registry_dir
  local top dir file
  top=$(git rev-parse --show-toplevel) || die 2 "The git repository cannot be found." "Run the command inside a git repository."
  dir=$(registry_dir) || exit $?
  for file in waivers.yaml waivers.log; do
    git -C "$top" ls-files --error-unmatch -- ".awf/$file" >/dev/null 2>&1 || continue
    cat "$top/.awf/$file" >>"$dir/$file" || die 30 "Copying .awf/$file to $dir failed."
    git -C "$top" rm -q -f -- ".awf/$file" || die 30 "Removing .awf/$file from git failed."
    echo "Migrated: .awf/$file to $dir/$file."
  done
}

context() {
  local name today dir
  dir=$(registry_dir) || exit $?
  today=$(date -u +%F)
  echo "Changes in progress:"
  changes_in . | sed 's/^/  /'
  echo "Worktrees:"
  git worktree list | sed 's/^/  /'
  echo "Worktree mounted on the running stack:"
  printf '  %s\n' "$(bash "$(dirname "$0")/commands.sh" mounted 2>/dev/null || echo unknown)"
  echo "Valid waivers:"
  name=$(grep -E "expires: [0-9-]+" "$dir/waivers.yaml" 2>/dev/null | awk -v t="$today" '{ match($0, /expires: [0-9-]+/); if (substr($0, RSTART + 9, 10) >= t) print "  " $0 }')
  echo "${name:-  none}"
}

sub=${1:-}
shift || true
case $sub in
  init) init "$@" ;;
  switch) switch "$@" ;;
  init-agent) init_agent "$@" ;;
  gate) gate "$@" ;;
  branch) change_branch "$@" ;;
  commit) commit "$@" ;;
  report) report "$@" ;;
  accept) accept "$@" ;;
  merge) merge "$@" ;;
  waive) waive "$@" ;;
  waived) waived "$@" ;;
  migrate) migrate ;;
  context) context ;;
  fingerprint) fingerprint "$@" ;;
  *) die 2 "Unknown subcommand \"$sub\"." "See the header of flow.sh." ;;
esac
