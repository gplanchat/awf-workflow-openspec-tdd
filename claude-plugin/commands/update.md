---
description: Revise an existing OpenSpec change through the flow-update workflow
argument-hint: <change> [description]
allowed-tools: Bash(awf run openspec-tdd/flow-update:*), Bash(cat:*), Bash(ls:*), Bash(awf run openspec-tdd/flow-review:*), Bash(AWF_WORKFLOWS_PATH=* awf resume:*), Read
---

Revise the artifacts of an existing change: `flow-update` runs the drafting agent in the worktree of the change, passes the gates and commits. The EGM review of the change follows.

**Input**: `$ARGUMENTS`, the name of a change of `openspec/changes/`, then an optional description of what changes.

**Steps**

1. Check that the input gives a change name in kebab-case. If it is missing, stop and ask for it. Invent no name.

2. Run the workflow from the root of the repository, with no other step:

   ```bash
   awf run openspec-tdd/flow-update --input change=<change> [--input request="<description>"]
   ```

3. If the workflow exits with code 2 and its output contains "The worktree ... is ready. Run again", it has just
   created `.worktrees/propose-<change>` (branch `docs/propose-<change>`) and stopped. Run the same command once more in the directory it names.

4. Give the report: read `.awf/status/flow-update.json` (in the worktree when the workflow runs there) and show the command, the
   change, the phase reached, the number of attempts, the waived gates and the status.

5. If the workflow fails, show the failed phase and the path of the report, without retrying:
   - `input` (code 2): an input is invalid; quote the message of the script;
   - `agent` (code 3): the agent failed before the gates;
   - `gate` (code 30): a gate fails; quote the gates of `.awf/status/flow-gate.failed` and the output of `.awf/status/flow-gate.log`;
   - `commit`: the commit of the workflow failed.

6. When the workflow succeeds, review the change with EGM: read `${CLAUDE_PLUGIN_ROOT}/commands/review.md` and follow
   its steps 2 to 5.

**Guardrails**
- Run no step other than `awf run`, the resume line of the review and reading the reports.
- Fix nothing yourself: no file, no commit, no waiver. To waive a gate, point to `/flow:waive`.
- The exit code of `awf` alone does not tell the phase: read the report.
