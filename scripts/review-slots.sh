#!/usr/bin/env bash
# Queue of review slots, independent of the TDD cycle (openspec/changes/tdd-gate-decoupe, design D1 to D3 and D6;
# openspec/changes/portes-preuves-et-perimetre, design D1 and D5).
#   review-slots.sh run -- <command...>              takes a slot, runs the command, releases the slot
#   review-slots.sh lease-run [--setup <command>] [--teardown <command>] -- <command...>
#                                                    takes or reuses the worktree lease, then runs the command
#   review-slots.sh lease-end                        marks the end of the lease and waits for its guardian to exit;
#                                                    with no lease held by the worktree: code 0, no wait, no marker
#   review-slots.sh queue                            held slots and waiting tickets (read-only, code 0)
#
# Exit codes:
#   2   wrong usage or invalid setting
#   13  no free slot within the timeout; a 13 from the command becomes 1
#   50  lease-run: the --setup command fails; a 50 from the command becomes 1 (run passes 50 through)
#   otherwise, the command's code
#
# The number of concurrent heavy reviews on the machine is bounded: TDD_REVIEW_SLOTS, then `review_slots` from
# .awf/config.yaml, then 2 (integer from 1 to 8), flock slots ${XDG_RUNTIME_DIR:-/tmp}/openspec-tdd-review-slot-<i>.lock.
# Slots go out in order of arrival: each waiting call drops a numbered ticket in
# ${XDG_RUNTIME_DIR:-/tmp}/openspec-tdd-review-queue/ (TDD_REVIEW_PRIORITY, integer, default 0: the smallest goes first); a
# ticket with no live process is deleted. The wait polls every 2 s (TDD_REVIEW_SLOT_STEP, for tests), counted once
# from the ticket's arrival: code 13 after 3600 s (TDD_REVIEW_SLOT_TIMEOUT).
#
# `run` holds the slot during its command: the kernel releases it when the process dies.
# `lease-run` holds one slot for all the calls of a worktree: the first takes it through the queue, runs --setup
# (output to stderr) and hands the slot to a detached guardian; the next ones reuse it without
# waiting or rerunning --setup. The guardian runs --teardown then releases the slot after `lease-end`, or after
# TDD_REVIEW_LEASE_IDLE s (60) with no command running. `lease-end` waits TDD_REVIEW_LEASE_WAIT s (10) at most for its exit.
# --setup and --teardown each take a command as a single string, run by `bash -c`.
#
# When TDD_REVIEW_WAIT_FILE names a file, `run` and `lease-run` write to it the seconds elapsed between their start
# and taking the slot (two decimals), before --setup and before the command: 0 for a reused lease, the length
# of the wait before code 13. Without this variable, no file is written.
#
# The worktree (lease fingerprint, "worktree" field of tickets) is OPENSPEC_ROOT, otherwise this script's repository.
# TDD_DRY_RUN=1 validates the settings then runs the command with no ticket, no slot, no --setup or --teardown, and
# without writing the wait.
set -u
launched_us=${EPOCHREALTIME/[.,]/} # script start, in microseconds

sub=${1:-}
shift 2>/dev/null || true

root=${OPENSPEC_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
rt_dir=${XDG_RUNTIME_DIR:-/tmp}
queue_dir=$rt_dir/openspec-tdd-review-queue

slot_count() { # prints the number of slots, or exits with code 2
  local slots=${TDD_REVIEW_SLOTS:-$(sed -nE 's/^[[:space:]]*review_slots:[[:space:]]*([^[:space:]#]*).*/\1/p' .awf/config.yaml 2>/dev/null | head -1)}
  slots=${slots:-2}
  if ! [[ $slots =~ ^[0-9]+$ ]] || (( slots < 1 || slots > 8 )); then
    echo "Invalid slot count \"$slots\": set an integer from 1 to 8 (TDD_REVIEW_SLOTS or review_slots in .awf/config.yaml)." >&2
    exit 2
  fi
  echo "$slots"
}
# A file is held when a flock -n fails on a read open; a missing file is not held. Creates nothing.
lock_held() { [[ -e $1 ]] && ( exec 3<"$1" 2>/dev/null && ! flock -n 3 ); }
slot_free() { ( exec 3>>"$1" && flock -n 3 ); }
live_tickets() { # prints "priority name" of live tickets, sorted (priority, number); with $1, deletes orphans
  local t
  for t in "$queue_dir"/*.ticket; do
    [[ -e $t ]] || continue
    if lock_held "$t"; then echo "$(head -n1 "$t" 2>/dev/null) $(basename "$t")"
    elif [[ -n ${1:-} ]]; then rm -f "$t"; fi
  done | sort -k1,1n -k2,2
}
report_wait() { # writes to TDD_REVIEW_WAIT_FILE the seconds elapsed since start, or $1 when given
  [[ -n ${TDD_REVIEW_WAIT_FILE:-} ]] || return 0
  local us=$(( ${EPOCHREALTIME/[.,]/} - launched_us ))
  if [[ -n ${1:-} ]]; then echo "$1"; else printf '%d.%02d\n' $((us / 1000000)) $((us % 1000000 / 10000)); fi >"$TDD_REVIEW_WAIT_FILE"
}
duration() { local s=$(( $(date +%s) - ${1:-0} )); echo "$((s / 60)) min $((s % 60)) s"; }

# Review slot: flock lock on descriptor 9, held until release_slot (or the process's death: the kernel
# releases it). Access follows order of arrival: a ticket locked by its waiter (descriptor 8), numbered under a
# flock counter (descriptor 7). Any waiter deletes a ticket with no live owner.
take_slot() {
  local slots limit=${TDD_REVIEW_SLOT_TIMEOUT:-3600} step=${TDD_REVIEW_SLOT_STEP:-2} start=$SECONDS announced="" i n ticket me free rank prio=${TDD_REVIEW_PRIORITY:-0}
  slots=$(slot_count) || exit 2
  if ! [[ $prio =~ ^-?[0-9]+$ ]]; then
    echo "Invalid priority \"$prio\": set an integer (TDD_REVIEW_PRIORITY)." >&2
    exit 2
  fi
  [[ -n ${TDD_DRY_RUN:-} ]] && return 0
  mkdir -p "$queue_dir"
  exec 7>"$queue_dir/.counter.lock"; flock 7
  n=$(( $(cat "$queue_dir/.counter" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"$queue_dir/.counter"
  me=$(printf '%010d.ticket' "$n"); ticket=$queue_dir/$me
  exec 8>"$ticket"; flock -n 8
  printf '%s\n%s\t%s\n' "$prio" "$root" "$(date +%s)" >&8
  exec 7>&-
  while :; do
    exec 7>"$queue_dir/.counter.lock"; flock 7
    rank=$(live_tickets clean | grep -n " $me\$" | cut -d: -f1); rank=$(( ${rank:-1} - 1 ))
    exec 7>&-
    free=0
    for ((i = 1; i <= slots; i++)); do slot_free "$rt_dir/openspec-tdd-review-slot-$i.lock" && free=$((free + 1)); done
    if (( rank < free )); then
      for ((i = 1; i <= slots; i++)); do
        exec 9<>"$rt_dir/openspec-tdd-review-slot-$i.lock"
        if flock -n 9; then
          : >/proc/self/fd/9
          printf '%s\t%s\n' "$root" "$(date +%s)" >&9
          rm -f "$ticket"; exec 8>&-
          report_wait
          return 0
        fi
        exec 9>&-
      done
    fi
    if (( SECONDS - start >= limit )); then
      rm -f "$ticket"; exec 8>&-
      report_wait
      echo "No free review slot after ${limit} s: other reviews hold all $slots slots. Retry later, or raise TDD_REVIEW_SLOTS (or review_slots in .awf/config.yaml)."
      exit 13
    fi
    if [[ -z $announced ]]; then echo "REVIEW waiting for a slot ($slots at most at the same time on the machine)."; announced=1; fi
    sleep "$step" 7>&- 8>&-
  done
}
release_slot() { exec 9>&-; }

# Worktree lease: the first call takes a slot through the queue and hands it to a detached guardian (setsid); the
# next ones reuse it without waiting. The guardian releases the slot when `lease-end` has dropped the end marker, or
# after TDD_REVIEW_LEASE_IDLE s (60) with no command running.
# ponytail: the guardian does not track the caller's death, only the idle fallback covers it.
lease_fp=$(printf %s "$root" | sha1sum | cut -c1-12)
lease_lock=$rt_dir/openspec-tdd-review-lease-$lease_fp.lock
lease_use=$rt_dir/openspec-tdd-review-use-$lease_fp.lock
lease_end=$rt_dir/openspec-tdd-review-end-$lease_fp
lease_gate=$rt_dir/openspec-tdd-review-wt-$lease_fp.lock

take_lease() { # take_lease <setup> <teardown>: takes or reuses the lease, then declares the use (descriptor 5)
  exec 6>"$lease_gate"; flock 6
  if ! ( exec 4>>"$lease_lock" && ! flock -n 4 ); then
    take_slot
    if [[ -n $1 ]]; then # D6: setup follows the slot; the guardian runs teardown before releasing lease_lock
      bash -c "$1" >&2 || { release_slot; exit 50; }
    fi
    rm -f "$lease_end"
    exec 4>>"$lease_lock"; flock -n 4
    setsid bash -c '
      end=$1; use=$2; idle=$3; poll=$4; since=$SECONDS
      while sleep "$poll"; do
        if ( exec 3>>"$use" && flock -n 3 ); then
          { [[ -e $end ]] || (( SECONDS - since >= idle )); } && break
        else since=$SECONDS; fi
      done
      [[ -n $5 ]] && bash -c "$5"
      rm -f "$end"
    ' guardian "$lease_end" "$lease_use" "${TDD_REVIEW_LEASE_IDLE:-60}" "${TDD_REVIEW_LEASE_POLL:-1}" "$2" </dev/null >/dev/null 2>&1 6>&- &
    exec 4>&- 9>&-
  else
    report_wait 0
  fi
  exec 5>>"$lease_use"; flock -s 5
  rm -f "$lease_end"
  exec 6>&-
}
# The marker comes before the wait for the guardian's exit, hence before the teardown and the slot release.
# With no lease held (D5: REVIEW whose tools are all reused), there is nothing to end: no marker, no wait.
end_lease() { lock_held "$lease_lock" || return 0; : >"$lease_end"; flock -w "${TDD_REVIEW_LEASE_WAIT:-10}" "$lease_lock" true; }

need_command() { # need_command <number of remaining arguments>
  (( $1 > 0 )) && return 0
  echo "No command after \"$sub\": the queue has nothing to run. Write review-slots.sh $sub -- <command>." >&2
  exit 2
}

case "$sub" in
  run)
    [[ ${1:-} == -- ]] && shift
    need_command $#
    take_slot
    "$@"; rc=$?
    release_slot
    (( rc == 13 )) && rc=1 # D3: 13 is reserved for the queue timeout
    exit "$rc"
    ;;
  lease-run)
    setup=""; teardown=""
    while (( $# )); do
      case "$1" in
        --setup)    setup=${2:-}; shift 2 2>/dev/null || shift ;;
        --teardown) teardown=${2:-}; shift 2 2>/dev/null || shift ;;
        --) shift; break ;;
        *) break ;;
      esac
    done
    need_command $#
    if [[ -n ${TDD_DRY_RUN:-} ]]; then take_slot; else take_lease "$setup" "$teardown"; fi
    "$@"; rc=$?
    (( rc == 13 || rc == 50 )) && rc=1 # D3: 13 is reserved for the timeout, 50 for setup
    exit "$rc"
    ;;
  lease-end)
    end_lease
    ;;
  queue) # read-only: no ticket, no slot, nothing deleted
    slots=$(slot_count) || exit 2
    echo "Slots ($slots at most):"
    for ((i = 1; i <= slots; i++)); do
      f=$rt_dir/openspec-tdd-review-slot-$i.lock
      wt=""; since=""
      if lock_held "$f"; then
        IFS=$'\t' read -r wt since <"$f" || true
        if [[ -n $since ]]; then echo "  $i  held  $wt  for $(duration "$since")"; else echo "  $i  held"; fi
      else echo "  $i  free"; fi
    done
    echo "Queue:"
    n=0
    while read -r prio name; do
      [[ -n $name ]] || continue
      n=$((n + 1))
      wt=""; since=""
      # priority on the first line, then "worktree<TAB>arrival"
      { read -r _; IFS=$'\t' read -r wt since; } <"$queue_dir/$name" 2>/dev/null || true
      echo "  rank $n  priority $prio  ${wt:-?}  for $(duration "${since:-$(date +%s)}")"
    done < <(live_tickets)
    (( n )) || echo "  empty"
    exit 0
    ;;
  *)
    echo "Unknown subcommand \"$sub\": choose run, lease-run, lease-end or queue." >&2
    exit 2
    ;;
esac
