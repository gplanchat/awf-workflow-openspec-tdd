---
description: Apply a change through the flow-apply workflow (apply-change, one TDD slice at a time)
argument-hint: <change>
allowed-tools: Bash(awf run openspec-tdd/flow-apply:*), Bash(cat:*), Bash(ls:*)
---

Apply a change: `flow-apply` creates the worktree `.worktrees/<change>`, then calls `apply-change`, which takes each code slice through RED, GREEN and the review. Launch it with `run_in_background`, log to the session scratchpad and wait for the completion notification, without polling or sleeping.

**Input**: `$ARGUMENTS`, the name of the change. The workflow can take up to 8 hours.

**Steps**

1. Check that the input gives a change name in kebab-case. If it is missing, stop and ask for it. Invent no name.

2. Run the workflow from the root of the repository, with no other step:

   ```bash
   awf run openspec-tdd/flow-apply --input change=<change>
   ```

3. If the workflow exits with code 2 and its output contains "The worktree ... is ready. Run again", it has just
   created `.worktrees/<change>` (branch `change/<change>`) and stopped. Run the same command once more in the directory it names.

4. Give the report: read `.awf/status/apply-change.json` (in the worktree when the workflow runs there) and show the command, the
   change, the phase reached, the number of attempts, the waived gates and the status.
   When its `skipped` list is not empty, name those tasks: their box stays unchecked because their "Verified by" command
   is missing or reads `Manual`. Quote its `uncommitted` list too: these files are in no commit.

5. If the workflow fails, show the failed phase and the path of the report, without retrying:
   - `input` (code 2): an input is invalid; quote the message of the script;
   - `agent` (code 3): the agent failed before the gates;
   - `gate` (code 30): a gate fails; quote the gates of `.awf/status/flow-gate.failed` and the output of `.awf/status/flow-gate.log`;
   - `commit`: the commit of the workflow failed.

**Guardrails**
- Run no step other than `awf run` and reading the report.
- Fix nothing yourself: no file, no commit, no waiver. To waive a gate, point to `/flow:waive`.
- The exit code of `awf` alone does not tell the phase: read the report.
