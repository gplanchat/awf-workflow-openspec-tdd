#!/usr/bin/env bash
# Phases of the apply-many workflow: apply-many.sh <init|create|run|verify|merge|e2e|report>
#
# Input (environment variables):
#   CHANGES      names of the changes separated by spaces, in merge order
#   MAX_CHANGES  changes applied at the same time; MAX is its former name (MAX_CHANGES wins)
#   MAX_TASKS    tasks applied at the same time in a (parallel) group of a change
#   MAX_TOTAL    cap of the tasks of (parallel) groups in progress on the machine
#   Empty, the values come from commands.sh settings (option, environment, default).
#   RUN_ID       identifier of the run (optional); WORKFLOW_ID the identifier of the awf workflow that carries it
#   AWF_PID      PID of the run's launcher, which holds the changes (by default the first ancestor named "awf")
#   WORKTREE_BIN, E2E_CMD  replace the operations of the project's command contract (see commands.sh)
#
# Several runs can go at the same time (different sessions). Each one has an identifier (RUN_ID, otherwise a
# timestamp and a random suffix, found again through WORKFLOW_ID in the next phases) and its directory
# .awf/status/apply-many/<identifier>/: tracking of each change (<change>.json), end-to-end result (e2e) and final
# report (apply-many.json), also copied to .awf/status/apply-many.json (the last report written). A change is applied
# by one run at a time (commands.sh claim, freed by release at the end or when the launcher dies). Operations of the
# contract (commands.sh): create <change>; run-all [--max-changes N] [--max-tasks N] [--max-total N] <change>...;
# verify <change>; merge <change>. Applying a change leaves its report in
# .worktrees/<change>/.awf/status/apply-change.json (written by apply-change in the worktree).
set -u

phase=${1:-}
here=$(dirname "$0")
worktree() { bash "$here/commands.sh" "$@"; }
max_changes=${MAX_CHANGES:-${MAX:-}}
max_tasks=${MAX_TASKS:-}
max_total=${MAX_TOTAL:-}
read -r -a changes <<<"${CHANGES:-}"
base=.awf/status/apply-many

# Identifier of the run: given, or found again through the workflow identifier, or created (init phase only).
run_id=${RUN_ID:-}
if [[ -z $run_id && -n ${WORKFLOW_ID:-} && -f $base/.runs/$WORKFLOW_ID ]]; then run_id=$(cat "$base/.runs/$WORKFLOW_ID"); fi
if [[ -z $run_id && $phase == init ]]; then run_id="$(date +%Y%m%dT%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"; fi
if [[ -z $run_id ]]; then
  echo "This apply-many run has no identifier: run the workflow again from the init phase." >&2
  exit 2
fi
dir=$base/$run_id

# PID of the run's launcher (awf run apply-many), which lives through every phase.
awf_pid() {
  [[ -n ${AWF_PID:-} ]] && { echo "$AWF_PID"; return; }
  local p=$PPID
  while [[ $p -gt 1 ]]; do
    [[ $(cat "/proc/$p/comm" 2>/dev/null) == awf ]] && { echo "$p"; return; }
    p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null || echo 1)
  done
  echo "$PPID"
}

state() { printf '%s/%s.json' "$dir" "$1"; }
upd() { # upd <change> <filtre jq> [--arg nom valeur]...
  local change=$1 filter=$2
  shift 2
  local tmp
  tmp=$(mktemp)
  jq "$@" "$filter" "$(state "$change")" >"$tmp" && mv "$tmp" "$(state "$change")"
}
get() { jq -r "$2" "$(state "$1")"; }

case "$phase" in
  init)
    if [[ ${#changes[@]} -eq 0 ]]; then
      echo "No change given. Give the names of the changes, separated by spaces." >&2
      exit 2
    fi
    for change in "${changes[@]}"; do
      if [[ ! $change =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
        echo "The change name \"$change\" is not valid: use lowercase letters, digits and hyphens only." >&2
        exit 2
      fi
    done
    for setting in "changes at the same time:$max_changes" "tasks at the same time per change:$max_tasks" "tasks in progress in total:$max_total"; do
      value=${setting#*:}
      if [[ -n $value ]] && ! [[ $value =~ ^[1-9][0-9]*$ ]]; then
        echo "The number of ${setting%%:*} \"$value\" is not valid: give an integer of 1 or more." >&2
        exit 2
      fi
    done
    # A change is applied by one run at a time: the claim fails before anything is created.
    if ! out=$(worktree claim --run "$run_id" --pid "$(awf_pid)" "${changes[@]}" 2>&1); then
      echo "$out"
      exit 2
    fi
    rm -rf "$dir"
    mkdir -p "$dir" "$base/.runs"
    [[ -n ${WORKFLOW_ID:-} ]] && echo "$run_id" >"$base/.runs/$WORKFLOW_ID"
    echo "Run $run_id"
    for change in "${changes[@]}"; do
      printf '{"change":"%s","created":false,"applied":false,"tasks_done":[],"failed":null,"verified":false,"merged":false,"conflict":[],"error":null}\n' "$change" >"$(state "$change")"
    done
    ;;

  create)
    for change in "${changes[@]}"; do
      if [[ -d ".worktrees/$change" ]]; then
        echo "Resuming the existing worktree: $change"
        upd "$change" '.created=true'
      elif out=$(worktree create "$change" 2>&1); then
        upd "$change" '.created=true'
      else
        upd "$change" '.error=$e' --arg e "worktree creation: $(tail -n 5 <<<"$out" | tr '\n' ' ')"
      fi
    done
    ;;

  run)
    created=()
    for change in "${changes[@]}"; do [[ $(get "$change" .created) == true ]] && created+=("$change"); done
    if [[ ${#created[@]} -eq 0 ]]; then
      echo "No worktree created: nothing to apply."
    else
      flags=()
      [[ -n $max_changes ]] && flags+=(--max-changes "$max_changes")
      [[ -n $max_tasks ]] && flags+=(--max-tasks "$max_tasks")
      [[ -n $max_total ]] && flags+=(--max-total "$max_total")
      worktree run-all "${flags[@]}" "${created[@]}" || true
    fi
    # Only the apply-change report says what happened; the exit code of run-all is not used.
    for change in "${created[@]}"; do
      report=.worktrees/$change/.awf/status/apply-change.json
      if [[ -f $report ]]; then
        upd "$change" '.applied=($r.status=="done") | .tasks_done=$r.done | .failed=$r.failed' --argjson r "$(cat "$report")"
      else
        upd "$change" '.error=$e' --arg e "apply-change left no report"
      fi
    done
    ;;

  verify)
    for change in "${changes[@]}"; do
      [[ $(get "$change" .applied) == true ]] || continue
      if out=$(worktree verify "$change" 2>&1); then
        upd "$change" '.verified=true'
      else
        upd "$change" '.error=$e' --arg e "isolation: $(tail -n 5 <<<"$out" | tr '\n' ' ')"
      fi
    done
    ;;

  merge)
    # One by one, in the given order; at the first conflict, merge-gate.sh aborts the merge and the next ones are not tried.
    stopped=false
    for change in "${changes[@]}"; do
      [[ $(get "$change" .verified) == true ]] || continue
      if [[ $stopped == true ]]; then
        upd "$change" '.error="merge not tried: a previous change is in conflict"'
        continue
      fi
      if out=$(worktree merge "$change" 2>&1); then
        upd "$change" '.merged=true'
      else
        stopped=true
        files=$(grep -oE '[A-Za-z0-9_./-]+\.[A-Za-z0-9]+' <<<"$(grep -i 'conflit\|conflict' <<<"$out")" | sort -u | jq -R . | jq -s .)
        upd "$change" '.conflict=$f | .error=$e' --argjson f "${files:-[]}" --arg e "merge: $(tail -n 5 <<<"$out" | tr '\n' ' ')"
      fi
    done
    ;;

  e2e)
    merged=false
    for change in "${changes[@]}"; do [[ $(get "$change" .merged) == true ]] && merged=true; done
    if [[ $merged == false ]]; then
      echo "No change merged: the end-to-end tests do not run."
      echo skipped >"$dir/e2e"
    elif [[ -z ${E2E_CMD:-} ]] && ! worktree --declared e2e; then
      echo "No e2e command declared in .awf/commands.yaml: the end-to-end tests do not run."
      echo skipped >"$dir/e2e"
    elif worktree e2e; then
      echo passed >"$dir/e2e"
    else
      echo failed >"$dir/e2e"
      exit 1
    fi
    ;;

  report)
    e2e_state=$(cat "$dir/e2e" 2>/dev/null || echo skipped)
    note="The end-to-end tests cover the main branch with the merges of this run and those other runs already made there."
    jq -s --arg run "$run_id" --arg e2e "$e2e_state" --arg note "$note" \
      '{run_id: $run, changes: ., e2e: $e2e, e2e_note: $note, status: (if ($e2e != "failed") and all(.[]; .merged) then "done" else "failed" end)}' \
      $(for change in "${changes[@]}"; do state "$change"; printf ' '; done) >"$dir/apply-many.json"
    cp "$dir/apply-many.json" .awf/status/apply-many.json
    worktree release --run "$run_id" "${changes[@]}" || true
    cat "$dir/apply-many.json"
    [[ $(jq -r .status "$dir/apply-many.json") == done ]] || exit 1
    ;;

  *)
    echo "Unknown phase \"$phase\": choose init, create, run, verify, merge, e2e or report." >&2
    exit 2
    ;;
esac
