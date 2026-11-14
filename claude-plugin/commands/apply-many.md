---
description: Apply several OpenSpec changes in parallel, one worktree each, then merge them into main
argument-hint: <change>... [--max-changes N] [--max-tasks N] [--max-total N]
allowed-tools: Bash(openspec:*), Bash(awf run openspec-tdd/apply-many:*), Bash(git status:*), Bash(git branch:*), Bash(git worktree list:*), Bash(cat:*)
---

Apply several OpenSpec changes at the same time. Each change runs in its own git worktree (`.worktrees/<change>`,
branch `change/<change>`). The `apply-many` workflow creates the worktrees, applies each change with `apply-change`
(each code slice goes through RED, GREEN and the review, with a fix loop), checks that no change wrote outside its
worktree, merges the finished changes into `main` one by one, then runs the project's end-to-end tests on `main`.

**Input**: `$ARGUMENTS`, the change names in merge order, optionally followed by the parallelism settings, for example
`order-totals invoice-pdf --max-changes 2 --max-tasks 2 --max-total 4`. If no name is given, run `openspec list --json`
and ask which changes to apply.

Three settings bound the parallelism. Each one is a whole number of 1 or more; any other value stops the run before a
worktree is created.

| Option | Meaning | Default |
|---|---|---|
| `--max-changes N` | changes applied at the same time | 2 |
| `--max-tasks N` | tasks of one change applied at the same time, only inside a group marked `(parallel)` | 1 (sequential) |
| `--max-total N` | cap of the tasks of `(parallel)` groups running on the machine, all changes and all runs together | 3 |

An option left out takes its value from the environment (`FLOW_MAX_CHANGES`, `FLOW_MAX_TASKS`, `FLOW_MAX_TOTAL`), then
from the default.

**Parallel tasks**: a group of `tasks.md` whose title ends with `(parallel)` declares its tasks independent of each
other. With `--max-tasks` above 1, those tasks run at the same time, each in a sub-worktree
(`.worktrees/<change>--<task>`) merged back into the change's worktree in task order. A group without the marker is
always applied task by task. Never add the marker to a group whose tasks touch the same files: the marker is the
author's statement of independence, and no tool checks it.

**Concurrent runs**: several runs can work on the same repository, for example from two sessions. Each run has an
identifier (the `run_id` input, otherwise a timestamp and a random suffix, printed as `Run <identifier>`). Its report is
`.awf/status/apply-many/<identifier>/apply-many.json`, and `.awf/status/apply-many.json` is a copy of the last report
written. A change is applied by one run at a time: a second run that asks for it stops before creating anything.

**Steps**

1. **Check the changes.** Run `openspec list --json`. Each name given must be an active change with a `tasks`
   artifact; otherwise stop and list the active changes. Check that each setting given is a whole number of 1 or more.
   The merge order is the order given: put first the changes that create files the others touch.

2. **Check `main`.** Run `git status --porcelain` and `git branch --show-current` from the root of the repository.
   `main` must be the current branch, the tree must be clean, and the current directory must not be a worktree
   (`git worktree list` shows the main worktree on its first line). Otherwise stop and say what to commit or where to
   run the command.

3. **Announce.** Say "Using changes: <a> <b> <c> (merge order), <N> changes at a time, <M> tasks per change, <T> tasks
   in total" and which groups carry the `(parallel)` marker. Show, for each change, its open tasks
   (`openspec instructions apply --change "<name>" --json`, progress only) and the worktree it gets. Say that the
   end-to-end tests run only on `main`, after the merges.

4. **Run the workflow in the background.**

   ```bash
   awf run openspec-tdd/apply-many --output streaming --input changes="<a> <b> <c>" --input max_changes=<N> --input max_tasks=<M> --input max_total=<T>
   ```

   Leave out an `--input` whose option was not given. Launch it with `run_in_background`, log to the session
   scratchpad, and wait for the completion notification. Do not poll, do not sleep, do not touch `main` or any
   worktree while it runs, and do not commit. A run can take well over an hour.

5. **Present the report.** Read `.awf/status/apply-many.json` (per change: `created`, `applied`, `tasks_done`,
   `failed`, `verified`, `merged`, `conflict`, `error`; then `e2e` and `status`). Show one line per change:

   ```
   ## Apply many: <status>

   | Change | Tasks done | Applied | Isolation | Merged | Note |
   ```

   For each change that did not finish:
   - **Application failed**: name the task (`failed.id`), the phase (`failed.phase`) and the status code (`30` is a
     review that still fails after three fixes, `20` a GREEN test, `10` a RED test that proves nothing, `12` a test
     that could not run). The phase `parallel` means that a task of a `(parallel)` group failed or could not be merged;
     its sub-worktree is kept. The worktree `.worktrees/<change>` is kept: resume with `/flow:apply <change>`, which
     restarts at the first open task.
   - **Isolation failed**: a file of `main` changed, and the change is not merged. Quote the file.
   - **Conflict**: quote the files. `main` is back to its state before that merge, and the next changes were not
     merged. Say which worktrees are kept.
   - **End-to-end tests failed**: the merges stay in `main`; show the failing scenarios.

6. **Clean up only on request.** Merged worktrees stay until the user asks to remove them.

**Guardrails**
- Announce the changes and the merge order before launching.
- Never apply two changes in the same directory: the workflow does it in worktrees only.
- Never resolve a merge conflict yourself; report it.
- The exit code of `awf` does not tell which phase failed: read the JSON reports.
- Report a failure as it is; never mark a task done that its gate did not pass.
- No commit, no push.
