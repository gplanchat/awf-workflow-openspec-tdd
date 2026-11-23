---
description: Archive a finished change through the flow-archive workflow (no agent)
argument-hint: <change>
allowed-tools: Bash(awf run openspec-tdd/flow-archive:*), Bash(cat:*), Bash(ls:*)
---

Archive a finished change: `flow-archive` stops while a box is open, replays the Definition of Done, runs `openspec archive --yes`, checks the result and commits. No agent takes part.

**Input**: `$ARGUMENTS`, the name of the change. Every box of `tasks.md` must be checked.

**Steps**

1. Check that the input gives a change name in kebab-case. If it is missing, stop and ask for it. Invent no name.

2. Run the workflow from the root of the repository, with no other step:

   ```bash
   awf run openspec-tdd/flow-archive --input change=<change>
   ```

3. If the workflow fails and its output contains "The worktree ... is ready. Run again", it has just
   created `.worktrees/propose-<change>` (branch `docs/propose-<change>`) and stopped. Run the same command once more in the directory it names.

4. Give the report: read `.awf/status/flow-archive.json` (in the worktree when the workflow runs there) and show the command, the
   change, the phase reached, the number of attempts, the waived gates and the status.

5. If the workflow fails, show the failed phase and the path of the report, without retrying:
   - `input`: an input is invalid; quote the message of the script;
   - `gate`: a gate fails; quote the gates of `.awf/status/flow-gate.failed` and the output of `.awf/status/flow-gate.log`;
   - `commit`: the commit of the workflow failed.

**Guardrails**
- Run no step other than `awf run` and reading the report.
- Fix nothing yourself: no file, no commit, no waiver. To waive a gate, point to `/flow:waive`.
- The exit code of `awf` alone does not tell the phase: read the report.
