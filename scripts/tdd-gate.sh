#!/usr/bin/env bash
# Gate of one phase of the TDD cycle: tdd-gate.sh <red|green|review|final> <language> [test-file...]
# Subcommands of the per-tool review (review-<language> workflows, see openspec/changes/tdd-par-langage):
#   tdd-gate.sh check <language> <tool>              one check: phpstan, psalm, deptrac, phpunit, infection (php);
#                                                    tsc, eslint, depcruise, vitest, stryker (ts);
#                                                    tsc, eslint, depcruise, vitest, budget, capture (threejs, no mutation); govet, gotest (go)
#   tdd-gate.sh classify <tool> [output]             writes red, green or stop to standard output
#   tdd-gate.sh red-mutants <language> [file...]     RED of a return for a mutant: the tests pass and target a mutated file
#   tdd-gate.sh green-turn <count|reset>             counter of the GREEN fix turns (code 1 at the fourth turn)
#   tdd-gate.sh queue                                review slots held and tickets waiting (read only, code 0)
#   tdd-gate.sh proofs purge                         removes the pass proofs and the reports older than TDD_PROOF_DAYS days
#   tdd-gate.sh resume-tool <language>               writes the mutation tool where the review resumes after a return to RED, or nothing (code 0)
# The language is a key of .awf/languages.yaml; `api` and `pwa` are its aliases for `php` and `ts`.
#
# The decision comes from the tools, never from what the agent declares.
#   0   the phase passes
#   2   misuse
#   10  RED: the test passes without production code, it proves nothing
#   11  RED: no new or modified test file to run
#   12  RED: the test could not run (no report: configuration, command or startup failed)
#   20  GREEN: a test fails, the REVIEW phase does not start
#   30  REVIEW: the review fails (raw output of the tool, no summary)
#   13  RED-MUTANTS: no test targets a file that the mutants hit
#   13  REVIEW, check: no free review slot within the timeout (TDD_REVIEW_SLOTS)
#
#   40  CAPTURE: the render differs from the approved one or the reference is missing, an art direction decision (never a fix turn)
#   50  GREEN, REVIEW and check php: test database unavailable (creation or migration failed, or the project's own guard rejects the database); the database is dropped
#
# The "final" phase is the review that follows the fix loop: it runs the review again only when the last one
# did not pass, because the loop also ends when a review passes.
#
# RED runs only the tests of the slice (arguments, TDD_RED_FILES, or else the test files that git sees as new
# or modified) and reads the JUnit report: a failure counts only when it comes from a test.
# The status of each phase is written to TDD_STATUS_FILE (default .awf/status/tdd-slice.json), because the exit
# code of awf does not carry the one of the workflow.
#
# Mutation testing (Infection for api/, Stryker for pwa/) covers only the production code of the current change:
# the files that git sees as different from main, committed or not. TDD_BASE replaces main with the commit at the start of a
# slice; a value that is not an ancestor commit of HEAD is discarded with a message. With no production file touched, only the
# static checks and the tests run. The full review stays `composer review` / `npm run review`
# (definition of done, CI).
#
# CPU use is capped to a share of the machine (cpu_percent, 50 % by default; see below), memory use
# to a size (memory_max, 16G by default).
#
# The number of heavy reviews running at once on the machine is bounded by .awf/scripts/review-slots.sh, which holds the queue of
# slots, the tickets and the worktree lease (see its header for TDD_REVIEW_SLOTS, TDD_REVIEW_PRIORITY,
# TDD_REVIEW_SLOT_TIMEOUT, TDD_REVIEW_LEASE_IDLE and the timeout code 13). The review phase holds it during its command
# (`review-slots.sh run`), the check phase for all the tools of a worktree (`review-slots.sh lease-run`, then `lease-end`
# at the last tool of the language or at the first failure). TDD_DRY_RUN takes none. `tdd-gate.sh queue` shows the queue.
#
# Overrides: TDD_RED_CMD (writes its report to $TDD_REPORT), TDD_TEST_CMD, TDD_REVIEW_CMD;
# TDD_CHECK_CMD_<TOOL> (the tool in upper case: TDD_CHECK_CMD_PHPUNIT) replaces the command of a single `check` tool,
# then TDD_CHECK_CMD the one of all the tools, then the default command;
# TDD_FORCE=1 runs the suite and each `check` tool again even when a pass proof holds for the tree, and rewrites the proof on success;
# TDD_DRY_RUN=1 prints the commands without running them.
# The default commands (test, review, RED, check tools, mutation, test databases) come from .awf/languages.yaml;
# the script replaces in them the markers {cpus}, {sources}, {files}, {report}, {mem_wrap}, {models}, {root}, {scripts},
# {change}, {slice} and {label}.
# Test databases: the URL that green_database_url or review_database_url prints is exported under the variable named by
# `database_url_env` in the registry (DATABASE_URL by default); an inherited value of that variable is ignored.
# GREEN: when the language declares green_setup, TDD_CHANGE and TDD_SLICE are mandatory (code 2 otherwise). The database of
# the slice is created by green_setup before the suite and dropped by green_teardown on exit.
# REVIEW (review, final and check phases): TDD_CHANGE (or else the name of the worktree folder) and TDD_SLICE (empty for the
# final review) give the label revue_<slice>, or revue_finale without a slice, passed as {label}. The database is created after taking
# the review slot and dropped before releasing it (check phase: by the lease keeper); the inherited URL is ignored, and code 50
# stops the REVIEW without calling an agent.
#
# The raw output of the review is also written to TDD_REVIEW_OUTPUT (default .awf/status/review-last.txt):
# the fix loop of the workflow has the agent read it without going through its prompt.
#
# Timings (portes-preuves-et-perimetre, D1): on exit, the red, green, review, check and red-mutants phases
# append a JSON line to TDD_TIMINGS_FILE (default .awf/status/tdd-gate-timings.jsonl):
#   {"phase":"check","language":"php","tool":"phpstan","seconds":40.12,"wait":12.03,"code":0,"reused":false}
# `language` is the kind from the registry (php for api), `tool` is empty outside check, `wait` is the wait for a slot
# that review-slots.sh writes to TDD_REVIEW_WAIT_FILE (created by the gate when the variable is empty), `seconds` the duration of
# the phase minus the wait, and `reused` is true when a proof spared running the suite or the tool. The line of the review phase of php and
# ts carries the sum of the waits of its tools, which each write their own line. TDD_DRY_RUN and a misuse (code 2) write no line. A
# failed write leaves a message on standard error and does not change the exit code; no decision of the gate
# reads a duration.
#
# Pass proofs (portes-preuves-et-perimetre, D2 to D5): when the test suite passes (green, check phpunit, check vitest)
# or a `check` tool listed in the `proofs` key of the language passes, the gate copies the report to
# <git-common-dir>/awf/preuves/<sha256> (the JUnit of `suite_report` for the suite, the output of the tool otherwise; TDD_SUITE_REPORT
# replaces the expected report), then records in the zpm base the fact
#   preuve(<tool>, <scope>, '<fingerprint>', <seconds since the epoch>, '<sha256 of the report>').
# The tool is the key of `checks`, or `suite` for the test suite, in green as in check. The scope is `complet`,
# or for mutation testing the SHA-256 of the sorted list of mutated files. The fingerprint is the one of `fingerprint <command>`.
# The base is <root of the main repository>/.zpm, shared by the worktrees and ignored by git; TDD_ZPM_ROOT replaces this root.
# The gate creates it with `zpm init` when it is missing, and runs each zpm command from that folder: a base in a parent
# folder is never read.
# Before running the tool, and before taking a review slot, `check` reads the proof with the same key. When its
# kept report has the recorded SHA-256, the tool does not run and the output reads
# `proof reused: <tool>, fingerprint <8 characters>` (`suite reused: fingerprint <8 characters>` for the suite, whose
# kept report is copied to `suite_report` when missing there). A proof whose report is missing or differs is
# removed. The tool runs without reading or writing when it is outside `proofs`, when the language has no
# `fingerprint_scope` or when its command is empty; it runs without writing when zpm is not in the PATH, when
# `zpm get-persistence-status` does not return `status: active` or when the zpm answer cannot be read. A zpm failure leaves
# a message on standard error and does not change the exit code. TDD_DRY_RUN does not call zpm.
#
# Purge (portes-preuves-et-perimetre, D8): `tdd-gate.sh proofs purge` removes from the base the proofs whose timestamp is older than
# TDD_PROOF_DAYS days (30 by default; a value that is not an integer from 1 to 99999 exits with code 2), in batches of 100
# at most until an empty answer, then deletes the reports of <git-common-dir>/awf/preuves/ older than that delay, whether a
# proof points to them or not. The report of a removed proof stays when a more recent proof rewrote it. Code 0 when zpm
# is not in the PATH, 1 when the base is not durable or zpm does not answer. flow-archive runs it after its commit.
#
# Review resume (portes-preuves-et-perimetre, D10): when the mutation check fails (infection for php, stryker
# for ts), `check` writes .awf/status/review-resume.json:
#   {"tool":"infection","fingerprint":"<fingerprint without tests>"}
# The fingerprint without tests is the one of the `fingerprint_scope` of the language, without the files of the `tests` patterns. `check`
# deletes this file at the first tool of `review_steps` and whenever mutation testing passes, reused proof included.
# `tdd-gate.sh resume-tool <language>` writes the tool name to standard output when the file names the mutation tool
# of the language and the recomputed fingerprint without tests is the same: since the failure, only test files changed.
# It writes nothing in any other case (file missing or unreadable, other tool, production, configuration or
# fixture file modified, language without mutation, without scope or unknown) and always exits with code 0.
set -u

# Current time in seconds, with a decimal point whatever the locale (EPOCHREALTIME follows LC_NUMERIC, as in merge-gate.sh).
now() { local LC_ALL=C LC_NUMERIC=C; printf '%s' "$EPOCHREALTIME"; }
t0=$(now)

phase=${1:-}
hexagon=${2:-}
shift 2 2>/dev/null || true
files=("$@")

# The review queue (slots, tickets, worktree lease) lives in review-slots.sh (tdd-gate-decoupe).
slots="bash $(dirname "$(readlink -f "$0")")/review-slots.sh"

# `queue`: read only, through review-slots.sh.
if [[ $phase == queue ]]; then exec $slots queue; fi

# Review routing (D6): independent of the language, it reads the failing tool and the fingerprint of its findings.
# TDD_FINDINGS_SHA keeps "fingerprint natural-phase stage turns" of the previous turn; the stage goes to 1 when the other
# phase was chosen, and a fourth turn is always a stop.
if [[ $phase == classify ]]; then
  tool=$hexagon
  findings=${files[0]:-${TDD_REVIEW_OUTPUT:-.awf/status/review-last.txt}}
  sha_file=${TDD_FINDINGS_SHA:-.awf/status/review-findings.sha}
  # Skipped mutants are not killed by one more test: they need faster tests or a longer timeout (GREEN).
  skipped_run=""; [[ $tool == infection ]] && grep -q 'Infection a sauté' "$findings" 2>/dev/null && skipped_run=1
  case "$tool" in
    capture) echo art-direction; exit 0 ;; # a human decision is not a turn: the counter stays intact
    required) echo stop; exit 0 ;; # a required tool without a command is a configuration gap, no agent turn fixes it
    trace) echo stop; exit 0 ;; # RED links each critical scenario to a test; a link lost at review (renamed scenario) stops the slice
    infection|stryker|mutants) natural=red;   other=green ;;
    phpstan|psalm|phpunit|deptrac|tsc|eslint|vitest|depcruise|govet|gotest|budget|fmt|clippy|unit|functional|integration|e2e|perf|harness) natural=green; other=red ;;
    *) echo "Unknown tool \"$tool\": choose phpstan, psalm, phpunit, deptrac, infection, tsc, eslint, vitest, depcruise, stryker, govet, gotest, budget, capture, fmt, clippy, unit, functional, integration, mutants, e2e, perf, harness or trace." >&2; exit 2 ;;
  esac
  fingerprint=$({ echo "$tool"; cat "$findings" 2>/dev/null; } | sha256sum | cut -d' ' -f1)
  prev_sha=""; prev_stage=0; prev_turns=0
  [[ -f $sha_file ]] && read -r prev_sha _ prev_stage prev_turns <"$sha_file"
  [[ -n $skipped_run ]] && { natural=green; other=red; }
  turns=$((prev_turns + 1)); stage=0; decision=$natural
  if (( turns > 3 )); then decision=stop
  elif [[ $prev_sha == "$fingerprint" ]]; then
    if (( prev_stage >= 1 )); then decision=stop; else decision=$other; stage=1; fi
  fi
  mkdir -p "$(dirname "$sha_file")"
  echo "$fingerprint $natural $stage $turns" >"$sha_file"
  echo "$decision"
  exit 0
fi

# GREEN fix turns (tdd-boucle-correction-green): count exits 0 up to the third turn, 1 after; reset sets it back to zero.
if [[ $phase == green-turn ]]; then
  turns_file=${TDD_GREEN_TURNS:-.awf/status/green-turns}
  mkdir -p "$(dirname "$turns_file")"
  case "$hexagon" in
    reset) echo 0 >"$turns_file"; exit 0 ;;
    count)
      n=0; [[ -f $turns_file ]] && read -r n <"$turns_file"
      [[ $n =~ ^[0-9]+$ ]] || n=0
      n=$((n + 1)); echo "$n" >"$turns_file"
      (( n <= 3 )); exit $? ;;
    *) echo "Unknown subcommand \"$hexagon\": choose count or reset." >&2; exit 2 ;;
  esac
fi

# Access to the proof store (D3): defined before the registry, because `proofs purge` takes no language.
zpm_root=""; proofs_dir=""
proof_note() { echo "Proof store: $1 The exit code of the tool does not change." >&2; }
zpm_do() { [[ -d $zpm_root/.zpm ]] && (cd "$zpm_root" && zpm "$@") 2>/dev/null </dev/null; }
# The base at the root of the main repository exists and zpm reports it durable. zpm missing: no message, installing it is optional.
store_ready() {
  local common state
  command -v zpm >/dev/null 2>&1 || return 1
  zpm_root=${TDD_ZPM_ROOT:-$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')}
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [[ -n $zpm_root && -d $zpm_root ]] || return 1
  proofs_dir=$common/awf/preuves
  # Without this check, zpm would walk up to the base of a parent folder (D3).
  [[ -d $zpm_root/.zpm ]] || (cd "$zpm_root" && zpm init) >/dev/null 2>&1
  state=$(zpm_do get-persistence-status --format json | jq -r '.[0]' 2>/dev/null)
  grep -qx 'status: active' <<<"$state" && return 0
  proof_note "the base $zpm_root/.zpm is not in durable mode, the tool runs and no proof is written. Run \"zpm get-persistence-status\" in $zpm_root to read its state."
  return 1
}

# Purge of old proofs (D8). The report of a removed proof goes with the reports older than the delay: its date is
# the one of the last proof that wrote it, so a report that a more recent proof shares (identical output) stays.
if [[ $phase == proofs ]]; then
  if [[ $hexagon != purge ]]; then
    echo "Unknown subcommand \"$hexagon\": choose purge." >&2
    exit 2
  fi
  days=${TDD_PROOF_DAYS:-30}
  if ! [[ $days =~ ^[0-9]{1,5}$ ]] || (( 10#$days < 1 )); then
    echo "Invalid retention delay \"$days\": give a whole number of days, from 1 to 99999 (TDD_PROOF_DAYS, 30 by default). No proof is removed." >&2
    exit 2
  fi
  days=$((10#$days))
  if ! command -v zpm >/dev/null 2>&1; then
    echo "Proof purge: zpm is not in the PATH, no proof is recorded on this machine and nothing is removed."
    exit 0
  fi
  if ! store_ready 2>/dev/null; then
    echo "Proof purge: the base ${zpm_root:-of the main repository}/.zpm is not in durable mode, no proof is removed. Run \"zpm get-persistence-status\" in that folder to read its state, then run \"tdd-gate.sh proofs purge\" again." >&2
    exit 1
  fi
  cutoff=$(( $(date +%s) - days * 86400 ))
  removed=0
  # query-logic returns 100 results at most: one batch per turn, until an empty answer.
  while :; do
    out=$(zpm_do query-logic --goal "preuve(O, P, E, T, S), T < $cutoff" --format json) \
      && rows=$(jq -r '.[0] | fromjson | if type == "array" then .[] else error("shape") end | "\(.O) \(.P) \(.E) \(.T) \(.S)"' <<<"$out" 2>/dev/null) \
      && { [[ -z $rows ]] || ! grep -qvE '^[a-z0-9_-]+ [a-z0-9]+ [0-9a-f]{64} [0-9]+ [0-9a-f]{64}$' <<<"$rows"; } \
      || { echo "Proof purge: the zpm answer cannot be read, $removed proof(s) removed before stopping. Check that zpm is version 0.4.4, then run \"tdd-gate.sh proofs purge\" again." >&2; exit 1; }
    [[ -n $rows ]] || break
    batch=0
    while read -r o p e t s; do
      zpm_do forget-fact --fact "preuve('$o', '$p', '$e', $t, '$s')" >/dev/null && batch=$((batch + 1))
    done <<<"$rows"
    removed=$((removed + batch))
    # A batch where no fact goes would come back identical: the loop stops.
    (( batch > 0 )) || { echo "Proof purge: zpm does not remove the old proofs, $removed proof(s) removed before stopping. Check that $zpm_root/.zpm is writable, then run \"tdd-gate.sh proofs purge\" again." >&2; exit 1; }
  done
  reports=0
  [[ -d $proofs_dir ]] && reports=$(find "$proofs_dir" -maxdepth 1 -type f ! -newermt "@$cutoff" -print -delete 2>/dev/null | wc -l)
  echo "Proof purge: $removed proof(s) and $reports report(s) older than $days day(s) removed."
  exit 0
fi

# Language registry (D3): file patterns read from .awf/languages.yaml, root = the one of the current git repository by default.
scripts=$(dirname "$(readlink -f "$0")")
root=${OPENSPEC_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
registry=$(OPENSPEC_ROOT=$root bash "$scripts/openspec-tasks.sh" languages 2>/dev/null) || registry='{}'
# reg <key>: value of the language key in the registry, empty when missing; a list gives one item per line.
reg() { jq -r --arg l "$hexagon" --arg k "$1" '.[$l][$k] // "" | if type == "array" then .[] else . end' <<<"$registry" 2>/dev/null; }
kind=$(reg workflow); kind=${kind#tdd-slice-}

# Tree fingerprint (D2): SHA-256 of the "path, content hash" pairs of the tracked and untracked files (ignored ones excluded)
# of the language scope, followed by the identity of the command. Scope set by task 1.1 (mesures.md).
# Code 1 at the slightest doubt (no git repository, no file): the caller then runs the suite again.
# A second argument excludes the files whose path matches the pattern (fingerprint without tests of the resume, D10).
fingerprint() { # fingerprint <command> [pattern of excluded files]
  local -a scope
  mapfile -t scope < <(reg fingerprint_scope)
  (( ${#scope[@]} )) || return 1
  local hashes
  hashes=$(git ls-files -z --cached --others --exclude-standard -- "${scope[@]}" 2>/dev/null | grep -zvE '(^|/)(reports|var)/|^\.awf/status/' | grep -zvE "${2:-^\$}" | xargs -0 -r sha256sum 2>/dev/null | LC_ALL=C sort) || return 1
  [[ -n $hashes ]] || return 1
  { echo "$hashes"; echo "commande:$1"; } | sha256sum | cut -d' ' -f1
}

# Review resume (D10, see the header). The mutation tool is the key of `checks` that carries the {mutation} marker.
resume_file=.awf/status/review-resume.json
mutation_tool=$(jq -r --arg l "$hexagon" '.[$l].checks // {} | to_entries[] | select(.value | contains("{mutation}")) | .key' <<<"$registry" 2>/dev/null | head -1)
resume_fingerprint() {
  local tests
  tests=$(jq -r --arg l "$hexagon" '.[$l].tests | join("|")' <<<"$registry" 2>/dev/null)
  [[ -n $tests ]] && fingerprint reprise "$tests"
}
# `resume-tool` comes before any usage check: it exits with code 0 whatever it reads.
if [[ $phase == resume-tool ]]; then
  if [[ -n $mutation_tool && $(jq -r '.tool' "$resume_file" 2>/dev/null) == "$mutation_tool" ]] \
    && fp=$(resume_fingerprint) && [[ $(jq -r '.fingerprint' "$resume_file" 2>/dev/null) == "$fp" ]]; then
    echo "$mutation_tool"
  fi
  exit 0
fi

[[ ${#files[@]} -eq 0 && -n ${TDD_RED_FILES:-} ]] && read -r -a files <<<"$TDD_RED_FILES"

# Commands per language (tdd-gate-decoupe, D4): read from the registry, a language without a `test` command is unknown.
registry_test=$(reg test)
if [[ -z $registry_test ]]; then
  echo "Unknown language \"$hexagon\": choose a key of .awf/languages.yaml (php, ts, threejs, go; api and pwa are their aliases)." >&2
  exit 2
fi
registry_review=$(reg review)
strip=$(reg strip)
report=${TDD_REPORT:-$(reg report)}
export TDD_REPORT="$report"
# Change and label of the test databases: {change} is TDD_CHANGE, or else the name of the worktree folder; {label} is
# revue_<slice>, or revue_finale without TDD_SLICE.
change=${TDD_CHANGE:-$(basename "$root")}
slice=${TDD_SLICE:-}
label=revue_finale; [[ -n $slice ]] && label="revue_$slice"
test_pattern=$(jq -r --arg l "$hexagon" '.[$l].tests | join("|")' <<<"$registry")
mutation_pattern=$(jq -r --arg l "$hexagon" '.[$l].mutation | join("|")' <<<"$registry")

# Share of the machine left to the tools: TDD_CPU_PERCENT, then `cpu_percent` of .awf/config.yaml, then 50. It becomes a
# number of cores (at least 1): the {cpus} marker of the registry, VITEST_MAX_WORKERS, and TDD_CPUS for the project's
# containers (a CPU quota in its compose file, for instance).
cpu_percent=${TDD_CPU_PERCENT:-$(sed -nE 's/^[[:space:]]*cpu_percent:[[:space:]]*([^[:space:]#]*).*/\1/p' .awf/config.yaml 2>/dev/null | head -1)}
cpu_percent=${cpu_percent:-50}
if ! [[ $cpu_percent =~ ^[0-9]+$ ]] || (( cpu_percent < 1 || cpu_percent > 100 )); then
  echo "Invalid CPU share \"$cpu_percent\": give an integer from 1 to 100 (TDD_CPU_PERCENT or cpu_percent in .awf/config.yaml)." >&2
  exit 2
fi
cores=$(nproc 2>/dev/null || echo 1)
cpus=$(( cores * cpu_percent / 100 )); (( cpus < 1 )) && cpus=1
export TDD_CPUS=$cpus VITEST_MAX_WORKERS=$cpus

# Memory left to the tools: TDD_MEMORY_MAX, then `memory_max` of .awf/config.yaml, then 16G.
# A size in M or G (512M, 8G); 0 removes the cap. The cap of {mem_wrap} is shared by all the REVIEWs of the
# machine: each runs its command in a scope of the user slice openspec-tdd-review.slice, whose MemoryMax is set here
# (the last value launched replaces the previous one). The project's containers get TDD_MEMORY_MAX, in lower case
# (mem_limit of a compose file), a cap per container: Docker cannot place a container in a user slice.
# Without systemd-run or systemctl, Stryker runs without a cap and the script says so.
memory_max=${TDD_MEMORY_MAX:-$(sed -nE 's/^[[:space:]]*memory_max:[[:space:]]*([^[:space:]#]*).*/\1/p' .awf/config.yaml 2>/dev/null | head -1)}
memory_max=${memory_max:-16G}
if ! [[ $memory_max =~ ^[0-9]+[MGmg]?$ ]]; then
  echo "Invalid memory cap \"$memory_max\": give a size such as 512M or 8G, or 0 for no cap (TDD_MEMORY_MAX or memory_max in .awf/config.yaml)." >&2
  exit 2
fi
mem_wrap=""
if [[ $memory_max =~ ^0+[MGmg]?$ ]]; then
  memory_max=0
elif command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  mem_wrap="systemctl --user set-property --runtime openspec-tdd-review.slice MemoryMax=${memory_max^^} && systemd-run --user --scope --quiet --slice=openspec-tdd-review.slice -- "
else
  echo "systemd-run or systemctl is missing: Stryker runs without a memory cap." >&2
fi
export TDD_MEMORY_MAX=${memory_max,,}

# Files of the change being written that match $1: those that git sees as different from the base of the change
# (TDD_BASE, main by default), committed, modified or new. On main itself, the base is HEAD: only the uncommitted counts.
# A TDD_BASE that is not an ancestor commit of HEAD (unknown identifier, commit of another branch) is discarded, and the
# gate says so: without this guard, the base becomes HEAD and mutation testing shrinks to the uncommitted files.
change_base=${TDD_BASE:-main}
if [[ $change_base != main ]] && ! git merge-base --is-ancestor "$change_base^{commit}" HEAD 2>/dev/null; then
  echo "TDD_BASE \"$change_base\" is not an ancestor commit of HEAD: the mutation base is main." >&2
  change_base=main
fi
change_files() {
  local base
  base=$(git merge-base HEAD "$change_base" 2>/dev/null || echo HEAD)
  { git diff --name-only --diff-filter=AMR "$base" 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null; } | sort -u | grep -E "$1"
}

# A file that declares only interfaces and types has no mutant: Stryker stops with "No tests were executed"
# when its whole selection is like that. A file without interface or type, or with executable code, stays in the selection.
has_runtime_code() {
  ! grep -qE '^(export )?(interface|type) ' "$1" || grep -qE '\b(function|class|const|let|var|enum)\b|^export default' "$1"
}

# Mutation testing covers only the production code of the change (`mutation` patterns of the registry), never the whole language.
# $mutation_cmd is the mutation command, empty when the change touches no mutated file.
mutation_sources=""; mutation_cmd=""; skipped_warning=""

# fill <template> [memory wrapper]: replaces the registry markers (D4). {change}, {slice} and {label} are
# quoted for the shell. The result is empty when the template expects {sources} or {models} and the list is empty:
# the command then has nothing to process.
fill() {
  local s=$1 wrap=${2-$mem_wrap} list="" pattern f q
  [[ $s == *'{sources}'* && -z $mutation_sources ]] && return 0
  if [[ $s == *'{models}'* ]]; then
    pattern=$(jq -r --arg l "$hexagon" '.[$l].models // [] | join("|")' <<<"$registry")
    [[ -n $pattern ]] && list=$(change_files "$pattern" | paste -sd' ' -)
    [[ -z $list ]] && return 0
    s=${s//'{models}'/"$list"}
  fi
  if [[ $s == *'{files}'* ]]; then
    list=""; for f in "${files[@]}"; do list+=" ${f#"$strip"}"; done
    s=${s//' {files}'/"$list"}; s=${s//'{files}'/"${list# }"}
  fi
  s=${s//'{cpus}'/"$cpus"}; s=${s//'{sources}'/"$mutation_sources"}; s=${s//'{report}'/"${report#"$strip"}"}
  s=${s//'{mem_wrap}'/"$wrap"}; s=${s//'{root}'/"$root"}; s=${s//'{scripts}'/"$root/.awf/scripts"}; s=${s//'{pack_scripts}'/"$scripts"}
  printf -v q %q "$change"; s=${s//'{change}'/"$q"}
  printf -v q %q "$slice"; s=${s//'{slice}'/"$q"}
  printf -v q %q "$label"; s=${s//'{label}'/"$q"}
  printf '%s' "$s"
}

if [[ -n $mutation_pattern ]]; then
  pattern_files=$(change_files "$mutation_pattern")
  # A TypeScript file that declares only interfaces and types leaves the selection (see has_runtime_code).
  mutation_sources=$(while read -r file; do [[ -n $file ]] && { [[ $file != *.ts ]] || has_runtime_code "$file"; } && echo "$file"; done <<<"$pattern_files" | sed "s#^$strip##" | paste -sd, -)
  # All the files of the pattern are interfaces and types: the REVIEW passes without mutating anything, and says so.
  [[ -n $pattern_files && -z $mutation_sources ]] && skipped_warning="Warning: no mutation testing, the files of the pattern declare only interfaces and types: $(paste -sd, - <<<"$pattern_files" | sed 's/,/, /g')."
  mutation_cmd=$(fill "$(reg mutation_cmd)")
fi
[[ -n $mutation_cmd ]] && registry_review+=" && $mutation_cmd"
# The warning opens the review command: it thus reaches review-last.txt without changing the exit code.
[[ -n $skipped_warning ]] && registry_review="echo '$skipped_warning' && $registry_review"

test_cmd=${TDD_TEST_CMD:-$registry_test}
review_cmd=${TDD_REVIEW_CMD:-$registry_review}

# Priority of the REVIEW processes: TDD_NICE (integer from 0 to 19); without a value, the REVIEW keeps the normal priority.
nice_level=${TDD_NICE:-}
if [[ -n $nice_level ]]; then
  if ! [[ $nice_level =~ ^[0-9]+$ ]] || (( nice_level > 19 )); then
    echo "Invalid priority \"$nice_level\": give an integer from 0 to 19 (TDD_NICE)." >&2
    exit 2
  fi
  review_cmd="nice -n $nice_level bash -c $(printf '%q' "$review_cmd")"
fi
status_file=${TDD_STATUS_FILE:-.awf/status/tdd-slice.json}
review_output=${TDD_REVIEW_OUTPUT:-.awf/status/review-last.txt}

record() { # record <code> <message>
  [[ -n ${TDD_DRY_RUN:-} ]] && return 0
  mkdir -p "$(dirname "$status_file")"
  printf '{"phase":"%s","hexagon":"%s","code":%s,"message":"%s"}\n' "$phase" "$hexagon" "$1" "${2//\"/\'}" >"$status_file"
}
finish() { record "$1" "$2"; exit "$1"; }

# Timings (D1, see the header). The inner call of check (TDD_CHECK_INNER) writes nothing: the outer call, which
# waited for the slot, writes the line of the tool.
timings_file=${TDD_TIMINGS_FILE:-.awf/status/tdd-gate-timings.jsonl}
timed=""; own_wait_file=""; wait_total=""; reused=false; exit_teardown=""
# Wait written by review-slots.sh; 0 when the file is missing or does not hold a number.
read_wait() {
  local w=""
  [[ -n ${TDD_REVIEW_WAIT_FILE:-} ]] && { read -r w <"$TDD_REVIEW_WAIT_FILE"; } 2>/dev/null
  [[ $w =~ ^[0-9]+(\.[0-9]+)?$ ]] && echo "$w" || echo 0
}
# A suite reused by GREEN writes only its "suite reused" line: the output of the phase tells whether it ran.
suite_reused() { [[ $(cat "$1" 2>/dev/null) =~ ^suite\ reused:\ fingerprint\ [0-9a-f]{8}$ ]]; }
on_exit() {
  local rc=$? w seconds line
  [[ -n $exit_teardown ]] && { bash -c "$exit_teardown" >&2 || true; }
  [[ -n $timed ]] || return 0
  w=${wait_total:-$(read_wait)}
  [[ -n $own_wait_file ]] && rm -f "$own_wait_file"
  (( rc == 2 )) && return 0 # misuse: no phase ran
  seconds=$(LC_ALL=C awk -v a="$t0" -v b="$(now)" -v w="$w" 'BEGIN { s = b - a - w; printf "%.2f", (s < 0 ? 0 : s) }')
  line=$(jq -cn --arg p "$phase" --arg l "$kind" --arg t "${tool:-}" --argjson s "$seconds" --argjson w "$w" --argjson c "$rc" --argjson r "$reused" \
    '{phase: $p, language: $l, tool: $t, seconds: $s, wait: $w, code: $c, reused: $r}' 2>/dev/null) \
    && { mkdir -p "$(dirname "$timings_file")" && echo "$line" >>"$timings_file"; } 2>/dev/null \
    || echo "The timings are not written: $timings_file is not writable. The exit code of the phase does not change; make this file writable to record the next timings." >&2
}
trap on_exit EXIT
case "$phase" in red|green|review|check|red-mutants)
  if [[ -z ${TDD_DRY_RUN:-} && -z ${TDD_CHECK_INNER:-} ]]; then
    timed=1
    if [[ -z ${TDD_REVIEW_WAIT_FILE:-} ]] && own_wait_file=$(mktemp 2>/dev/null); then export TDD_REVIEW_WAIT_FILE=$own_wait_file; fi
    # The file inherited from the review phase keeps the wait of the previous tool: it starts again from zero.
    [[ -n ${TDD_REVIEW_WAIT_FILE:-} ]] && { : >"$TDD_REVIEW_WAIT_FILE"; } 2>/dev/null
  fi ;;
esac

run() {
  if [[ -n ${TDD_DRY_RUN:-} ]]; then echo "$1"; return 0; fi
  bash -c "$1" 2>&1
}

# Proof store (D2 to D5, see the header). proof_begin sets proof_fp and proof_sha, and proof_write when the success of
# the tool must write a proof.
proof_write=""; proof_name=""; proof_scope=""; proof_fp=""; proof_sha=""
suite_report=${TDD_SUITE_REPORT:-$(reg suite_report)}
# proof_begin <tool> <scope> <command>: 0 when a valid proof spares running the tool. A proof whose report
# is missing or differs is removed; with TDD_FORCE=1, every proof of the key is removed and the tool runs.
proof_begin() {
  local out rows t s file
  proof_write=""; proof_sha=""; proof_name=$1; proof_scope=$2
  proof_fp=$(fingerprint "$3") || return 1
  store_ready || return 1
  out=$(zpm_do query-logic --goal "preuve($proof_name, $proof_scope, '$proof_fp', T, S)" --format json) \
    && rows=$(jq -r '.[0] | fromjson | if type == "array" then .[] else error("shape") end | "\(.T) \(.S)"' <<<"$out" 2>/dev/null) \
    && ! grep -qvE '^[0-9]+ [0-9a-f]{64}$' <<<"${rows:-0 $proof_fp}" \
    || { proof_note "the zpm answer cannot be read, the tool runs and no proof is written. Check that zpm is version 0.4.4."; return 1; }
  proof_write=1
  while read -r t s; do
    [[ -n $s ]] || continue
    file=$proofs_dir/$s
    if [[ ${TDD_FORCE:-} != 1 && -z $proof_sha && -f $file && $(sha256sum "$file" 2>/dev/null | cut -d' ' -f1) == "$s" ]]; then
      proof_sha=$s
    elif [[ ${TDD_FORCE:-} == 1 || -z $proof_sha ]]; then
      zpm_do forget-fact --fact "preuve($proof_name, $proof_scope, '$proof_fp', $t, '$s')" >/dev/null \
        || proof_note "the stale proof of $proof_name is not removed."
    fi
  done <<<"$rows"
  [[ -n $proof_sha ]]
}
# proof_save <report>: after a success, keeps the report under its SHA-256 then writes the proof.
proof_save() {
  local sha out
  [[ -n $proof_write && -n $1 && -f $1 ]] || return 0
  if sha=$(sha256sum "$1" 2>/dev/null | cut -d' ' -f1) && [[ -n $sha ]] && mkdir -p "$proofs_dir" 2>/dev/null \
    && cp "$1" "$proofs_dir/$sha.tmp.$$" 2>/dev/null && mv "$proofs_dir/$sha.tmp.$$" "$proofs_dir/$sha" \
    && out=$(zpm_do remember-fact --fact "preuve($proof_name, $proof_scope, '$proof_fp', $(date +%s), '$sha')") && [[ $out == Asserted* ]]; then
    return 0
  fi
  proof_note "the proof of $proof_name is not written, the tool runs again on this tree. Check that $proofs_dir and $zpm_root/.zpm are writable."
}
# A reused suite gets its JUnit report back: the tools that read it after the suite find it as after a run (D4).
suite_restore() { [[ -f $suite_report ]] || { mkdir -p "$(dirname "$suite_report")" && cp "$proofs_dir/$proof_sha" "$suite_report"; } 2>/dev/null; }
in_proofs() { reg proofs | grep -qxE "$1"; }

# Runs the GREEN test suite, or skips it when a `suite` proof holds for the tree fingerprint (D2).
run_suite() { # run_suite <command>
  local cmd=$1 rc
  if [[ -n ${TDD_DRY_RUN:-} ]]; then run "$cmd"; return; fi
  if in_proofs 'phpunit|vitest' && proof_begin suite complet "$cmd" && suite_restore; then
    echo "suite reused: fingerprint ${proof_fp:0:8}"
    return 0
  fi
  run "$cmd"; rc=$?
  (( rc == 0 )) && proof_save "$suite_report"
  return $rc
}

# Variable that receives the URL of a test database (D4): `database_url_env` of the registry, DATABASE_URL by default.
db_env=$(reg database_url_env); db_env=${db_env:-DATABASE_URL}
if ! [[ $db_env =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "Invalid database_url_env \"$db_env\" for $hexagon: give a shell variable name such as DATABASE_URL." >&2
  exit 2
fi

review_base_names() { # D4, D6: commands of the REVIEW database, read from the registry; the inherited URL is ignored when the language declares one
  review_setup=$(fill "$(reg review_setup)")
  review_teardown=$(fill "$(reg review_teardown)")
  review_url=$(fill "$(reg review_database_url)")
  [[ -n $review_setup$review_url ]] && unset "$db_env"
  return 0
}

# Command of a `checks` marker (D4): {mutation} is the mutation command, {budget} and {capture} the key with the same
# name. The capture runs in the openspec-tdd-review.slice scope with CPUQuota = cpus * 100 %. With no mutated file and no model
# touched, the command is empty and the check passes.
named_command() {
  local wrap=$mem_wrap
  case "$1" in
    mutation) printf '%s' "$mutation_cmd" ;;
    capture) [[ -n $wrap ]] && wrap=${wrap/--slice=openspec-tdd-review.slice/--slice=openspec-tdd-review.slice -p CPUQuota=$((cpus * 100))%}
             fill "$(reg capture)" "$wrap" ;;
    *) fill "$(reg "$1")" ;;
  esac
}

# Test files of the slice: those that git sees as new or modified, hexagon by hexagon.
changed_tests() {
  local found shape_pattern
  found=$(git status --porcelain --untracked-files=all 2>/dev/null | sed -E 's/^.{3}//; s/.* -> //' | grep -E "$test_pattern")
  # Shape tests belong to the threejs kind (D3): a ts slice does not take them.
  if [[ $kind == ts ]]; then
    shape_pattern=$(jq -r '.threejs.tests // [] | join("|")' <<<"$registry")
    [[ -n $shape_pattern ]] && found=$(grep -vE "$shape_pattern" <<<"$found")
  fi
  [[ -n $found ]] && echo "$found"
}

# Counts the test failures and errors of the JUnit report (tests run, failures, errors).
junit_counts() {
  local head tests failures errors
  head=$(grep -m1 -oE '<testsuites?[^>]* (failures|errors)="[0-9]+"[^>]*>' "$1" 2>/dev/null) || return 1
  tests=$(grep -oE ' tests="[0-9]+"' <<<"$head" | head -1 | grep -oE '[0-9]+'); failures=$(grep -oE ' failures="[0-9]+"' <<<"$head" | head -1 | grep -oE '[0-9]+')
  errors=$(grep -oE ' errors="[0-9]+"' <<<"$head" | head -1 | grep -oE '[0-9]+')
  echo "${tests:-0} ${failures:-0} ${errors:-0}"
}

red_command() { fill "$(reg red)"; } # RED command that runs only the files of the slice

case "$phase" in
  red)
    if [[ ${#files[@]} -eq 0 ]]; then
      mapfile -t files < <(changed_tests)
    fi
    if [[ ${#files[@]} -eq 0 && -z ${TDD_RED_CMD:-} ]]; then
      echo "No new or modified test file for the hexagon $hexagon: the RED phase must write at least one test."
      finish 11 "no test file"
    fi
    cmd=${TDD_RED_CMD:-$(red_command)}
    [[ -n ${TDD_DRY_RUN:-} ]] || mkdir -p "$(dirname "$report")"
    rm -f "$report"
    run "$cmd"
    [[ -n ${TDD_DRY_RUN:-} ]] && exit 0
    if ! counts=$(junit_counts "$report"); then
      echo
      echo "The test could not run: no test report in $report. Fix the command or the configuration, then run RED again."
      finish 12 "no test report"
    fi
    read -r tests failures errors <<<"$counts"
    if [[ $((failures + errors)) -eq 0 ]]; then
      echo
      echo "The test written in RED passes without production code ($tests test(s) run): it proves nothing. Write a test that fails for the right reason."
      finish 10 "test passes without production code"
    fi
    echo
    echo "RED: $((failures + errors)) test failure(s) out of $tests, caused by the tests of the slice."
    finish 0 "red ok"
    ;;
  green)
    # Private database of the slice (D4): green_setup before the suite, green_database_url exported under $db_env,
    # green_teardown on exit. The inherited URL is ignored when the language declares a database.
    green_setup=$(reg green_setup)
    if [[ -n $green_setup && ( -z ${TDD_CHANGE:-} || -z ${TDD_SLICE:-} ) ]]; then
      echo "GREEN $kind: set TDD_CHANGE and TDD_SLICE (the change and the slice); the test database depends on them." >&2
      exit 2
    fi
    green_setup=$(fill "$green_setup")
    green_teardown=$(fill "$(reg green_teardown)")
    green_url=$(fill "$(reg green_database_url)")
    [[ -n $green_setup$green_url ]] && unset "$db_env"
    if [[ -n ${TDD_DRY_RUN:-} ]]; then
      [[ -n $green_setup ]] && echo "$green_setup"
      [[ -n $green_url ]] && echo "$db_env=\$($green_url) $test_cmd"
      [[ -n $green_teardown ]] && echo "$green_teardown"
    else
      exit_teardown=$green_teardown
      if [[ -n $green_setup ]]; then bash -c "$green_setup" >&2 || finish $? "test database unavailable"; fi
      if [[ -n $green_url ]]; then
        url=$(bash -c "$green_url") || finish $? "test database unavailable"
        export "$db_env=$url"
      fi
    fi
    green_out=$(mktemp)
    if [[ -n ${TDD_DRY_RUN:-} ]]; then run "$test_cmd"; rc=$?; else run_suite "$test_cmd" | tee "$green_out"; rc=${PIPESTATUS[0]}; fi
    if (( rc != 0 )); then
      # The fix loop (tdd-boucle-correction-green) reads the output of the suite again in review-last.txt.
      mkdir -p "$(dirname "$review_output")"; cp "$green_out" "$review_output"; rm -f "$green_out"
      echo
      echo "A test fails at the end of the GREEN phase: the REVIEW phase does not start."
      finish 20 "test failed"
    fi
    suite_reused "$green_out" && reused=true
    rm -f "$green_out"
    finish 0 "green ok"
    ;;
  review)
    rc=0
    review_base_names
    if [[ -n ${TDD_DRY_RUN:-} ]]; then
      $slots run -- true || exit $?
      [[ -n $review_setup ]] && echo "$review_setup"
      [[ -n $review_url ]] && review_cmd="$db_env=\$($review_url) $review_cmd"
      run "$review_cmd"
      [[ -n $review_teardown ]] && echo "$review_teardown"
    elif [[ -z ${TDD_REVIEW_CMD:-} && ( $kind == php || $kind == ts ) ]]; then
      # D1, D2: the static checks, the architecture, the suite then mutation testing (each reused when a proof holds),
      # each through `check`, so through the same command as GREEN and as the steps of the review-* workflows.
      [[ -n $nice_level ]] && renice -n "$nice_level" -p $$ >/dev/null 2>&1
      mkdir -p "$(dirname "$review_output")"
      : >"$review_output"
      [[ -n $skipped_warning ]] && echo "$skipped_warning" | tee -a "$review_output"
      wait_total=0
      for step in $(reg review_steps); do
        TDD_STATUS_FILE=/dev/null TDD_REVIEW_OUTPUT="$review_output.step" bash "$0" check "$hexagon" "$step"
        rc=$?
        wait_total=$(LC_ALL=C awk -v a="$wait_total" -v b="$(read_wait)" 'BEGIN { printf "%.2f", a + b }')
        cat "$review_output.step" >>"$review_output" 2>/dev/null
        [[ $rc -ne 0 ]] && break
      done
      rm -f "$review_output.step"
    else
      mkdir -p "$(dirname "$review_output")"
      # The REVIEW database is created after taking the slot and dropped before releasing it: it all fits in the
      # command that `review-slots.sh run` launches. A creation failure exits with code 50, which `run` passes through.
      inner=""
      [[ -n $review_teardown ]] && inner+="trap '$review_teardown >&2' EXIT; "
      [[ -n $review_setup ]] && inner+="$review_setup >&2 || exit 50; "
      [[ -n $review_url ]] && inner+="export $db_env=\$($review_url); "
      inner+="$review_cmd"
      $slots run -- bash -c "$inner" 2>&1 | tee "$review_output"
      rc=${PIPESTATUS[0]}
      (( rc == 13 )) && exit 13
      (( rc == 50 )) && finish 50 "test database unavailable"
    fi
    if [[ $rc -ne 0 ]]; then
      echo
      echo "The REVIEW phase fails: fix what the tool reports above."
      finish 30 "review failed"
    fi
    finish 0 "review ok"
    ;;
  check)
    tool=${files[0]:-}
    cmd=$(jq -r --arg l "$hexagon" --arg t "$tool" '.[$l].checks[$t] // ""' <<<"$registry")
    # A critical slice (TDD_CRITICAL=1) does not accept a missing or empty command for a tool listed in `required`.
    if [[ -z $cmd && ${TDD_CRITICAL:-} == 1 ]] && reg required | grep -qxF "$tool"; then
      echo "$tool: no command in \`checks\`, but a critical slice requires it (\`required\` in .awf/languages.yaml). Declare its command in \`checks\`."
      finish 30 "required $tool has no command"
    fi
    if [[ -z $cmd ]]; then
      echo "Unknown tool \"$tool\" for the language $hexagon: see the header of tdd-gate.sh for the list of tools." >&2
      exit 2
    fi
    cmd=$(fill "$cmd")
    for mark in mutation budget capture; do
      [[ $cmd == *"{$mark}"* ]] && cmd=${cmd//"{$mark}"/"$(named_command "$mark")"}
    done
    # Proof of mutation testing: its scope is the fingerprint of the sorted list of mutated files (D2).
    proof_scope=complet
    [[ $(jq -r --arg l "$hexagon" --arg t "$tool" '.[$l].checks[$t]' <<<"$registry") == *'{mutation}'* ]] \
      && proof_scope="'$(tr ',' '\n' <<<"$mutation_sources" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)'"
    tool_var=TDD_CHECK_CMD_${tool^^}
    cmd=${!tool_var:-${TDD_CHECK_CMD:-$cmd}}
    # An empty command runs nothing: the check passes without reading or writing a proof.
    provable=1; [[ -z $cmd ]] && { cmd=true; provable=""; }
    if [[ -n ${TDD_DRY_RUN:-} ]]; then $slots run -- true || exit $?; run "$cmd"; exit 0; fi
    review_base_names
    mkdir -p "$(dirname "$review_output")"
    if [[ -n ${TDD_CHECK_INNER:-} ]]; then
      # Called by `review-slots.sh lease-run` below: the tool itself, under the lease, without status or queue.
      if [[ -n $review_url ]]; then url=$(bash -c "$review_url"); export "$db_env=$url"; fi
      bash -c "$cmd" 2>&1 | tee "$review_output"
      exit "${PIPESTATUS[0]}"
    fi
    last=${TDD_LAST:-$(reg last)} # the review workflow passes the last tool of the list it runs
    # D10: the first tool of a review clears the resume left by the previous review.
    [[ $tool == "$(reg review_steps | head -1)" ]] && rm -f "$resume_file"
    # D5: the proof is read before the queue. A reused tool takes no ticket, no slot and no test database.
    proof_tool=$tool; proof_report=$review_output
    [[ $tool == vitest || $tool == phpunit ]] && { proof_tool=suite; proof_report=$suite_report; }
    if [[ -n $provable ]] && in_proofs "$tool" && proof_begin "$proof_tool" "$proof_scope" "$cmd" && { [[ $proof_tool != suite ]] || suite_restore; }; then
      if [[ $proof_tool == suite ]]; then echo "suite reused: fingerprint ${proof_fp:0:8}"; else echo "proof reused: $tool, fingerprint ${proof_fp:0:8}"; fi | tee "$review_output"
      reused=true
      [[ $tool == "$mutation_tool" ]] && rm -f "$resume_file"
      [[ $tool == "$last" ]] && $slots lease-end
      finish 0 "$tool ok"
    fi
    # An empty command takes no ticket, no slot and no test database: nothing runs.
    if [[ -z $provable ]]; then
      echo "$tool: no command to run" | tee "$review_output"
      [[ $tool == "$mutation_tool" ]] && rm -f "$resume_file"
      [[ $tool == "$last" ]] && $slots lease-end
      finish 0 "$tool ok"
    fi
    # review-slots.sh holds the worktree lease: the first tool takes the slot and runs the database setup,
    # the keeper runs the cleanup before releasing the slot. Code 13 is the timeout, 50 the setup failure.
    TDD_CHECK_INNER=1 TDD_STATUS_FILE=/dev/null $slots lease-run ${review_setup:+--setup "$review_setup"} ${review_teardown:+--teardown "$review_teardown"} -- bash "$0" check "$hexagon" "$tool"
    rc=$?
    (( rc == 13 )) && exit 13
    (( rc == 50 )) && finish 50 "test database unavailable"
    (( rc == 0 )) && proof_save "$proof_report"
    # D10: failed mutation testing leaves the tool and the fingerprint without tests; its success clears the resume. Without a fingerprint
    # (no scope) or when writing is impossible, no file stays and the next review starts again from its first tool.
    if [[ $tool == "$mutation_tool" ]]; then
      rm -f "$resume_file"
      (( rc != 0 )) && resume_fp=$(resume_fingerprint) && mkdir -p "$(dirname "$resume_file")" 2>/dev/null \
        && { jq -cn --arg t "$tool" --arg f "$resume_fp" '{tool: $t, fingerprint: $f}' >"$resume_file"; } 2>/dev/null
    fi
    if [[ $rc -ne 0 || $tool == "$last" ]]; then $slots lease-end; fi
    if [[ $tool == capture && ( $rc == 40 || $rc == 12 ) ]]; then
      echo
      [[ $rc == 40 ]] && echo "The capture differs from the approved reference, or the reference is missing: art direction decides." || echo "The capture could not run (dependency, lock or timeout): fix it, then run the review again."
      finish "$rc" "capture exited with code $rc"
    fi
    if [[ $rc -ne 0 ]]; then
      echo
      echo "The $tool check fails: fix what the tool reports above."
      finish 30 "$tool failed"
    fi
    finish 0 "$tool ok"
    ;;
  red-mutants)
    # Return to RED for a surviving mutant (D7): the tests must pass on the current code and target a mutated file.
    if [[ ${#files[@]} -eq 0 ]]; then
      mapfile -t files < <(changed_tests)
    fi
    if [[ ${#files[@]} -eq 0 ]]; then
      echo "No new or modified test file for the language $hexagon: add a test that kills the mutant."
      finish 11 "no test file"
    fi
    cmd=${TDD_RED_CMD:-$(red_command)}
    [[ -n ${TDD_DRY_RUN:-} ]] || mkdir -p "$(dirname "$report")"
    rm -f "$report"
    run "$cmd"
    [[ -n ${TDD_DRY_RUN:-} ]] && exit 0
    if ! counts=$(junit_counts "$report"); then
      echo
      echo "The test could not run: no test report in $report. Fix the command or the configuration, then run RED again."
      finish 12 "no test report"
    fi
    read -r tests failures errors <<<"$counts"
    if [[ $((failures + errors)) -ne 0 ]]; then
      echo
      echo "A test fails on the current code ($((failures + errors)) out of $tests): a test that kills a mutant must pass. Fix it."
      finish 20 "test failed"
    fi
    # A test targets a mutated file when its name, without the test suffix, appears in a path of the review output.
    targeted=""
    for f in "${files[@]}"; do
      stem=$(basename "$f"); stem=${stem%%.*}; stem=${stem%Test}; stem=${stem%_tests}
      # Rust: src/<module>/tests.rs tests the module of its folder (src/<module>.rs or src/<module>/mod.rs).
      [[ $f == *.rs && $stem == tests ]] && stem=$(basename "$(dirname "$f")")
      [[ -n $stem && -f $review_output ]] && grep -qE "(^|[/ ])${stem}(\.[A-Za-z]+|/)" "$review_output" && { targeted=$f; break; }
    done
    if [[ -z $targeted ]]; then
      echo
      echo "No test targets a file that the mutants hit (see $review_output): add the test to the test file of the mutated class."
      finish 13 "test outside the mutated files"
    fi
    echo
    echo "RED: $tests test(s) pass on the current code and target the mutated file of $targeted; the next review judges the mutant."
    finish 0 "red mutants ok"
    ;;
  final)
    if [[ -z ${TDD_DRY_RUN:-} && -f $status_file ]] && grep -q '"phase":"review","hexagon":"'"$hexagon"'","code":0' "$status_file"; then
      echo "The review already passed: it does not run again."
      exit 0
    fi
    phase=review
    exec bash "$0" review "$hexagon"
    ;;
  *)
    echo "Unknown phase \"$phase\": choose red, green, review, final, check, classify, red-mutants, queue, proofs or resume-tool." >&2
    exit 2
    ;;
esac
