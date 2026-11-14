---
description: Accept a proposed change and merge its branch into main through the flow-accept workflow
argument-hint: <change>
allowed-tools: Bash(awf run openspec-tdd/flow-accept:*), Bash(cat:*), Bash(ls:*)
---

Accept a proposed change: `flow-accept` passes the gates, writes `acceptance.yaml` (reviewer, date, fingerprint of the Definition of Done) and merges `docs/propose-<change>` into `main` without pushing. No agent takes part, and the Definition of Done is not replayed: the code does not meet it yet.

**Input**: `$ARGUMENTS`, the name of the change. Running the command is your order to merge.

**Steps**

1. Check that the input gives a change name in kebab-case. If it is missing, stop and ask for it. Invent no name.

2. Run the workflow from the root of the repository, with no other step:

   ```bash
   awf run openspec-tdd/flow-accept --input change=<change>
   ```

3. If the workflow exits with code 2 and its output contains "The worktree ... is ready. Run again", it has just
   created `.worktrees/propose-<change>` (branch `docs/propose-<change>`) and stopped. Run the same command once more in the directory it names.

4. Give the report: read `.awf/status/flow-accept.json` (in the worktree when the workflow runs there) and show the command, the
   change, the phase reached, the number of attempts, the waived gates and the status.

5. If the workflow fails, show the failed phase and the path of the report, without retrying:
   - `input` (code 2): an input is invalid; quote the message of the script;
   - `gate` (code 30): a gate fails; quote the gates of `.awf/status/flow-gate.failed` and the output of `.awf/status/flow-gate.log`;
   - `commit`: the commit of the workflow failed.

**Guardrails**
- Run no step other than `awf run` and reading the report.
- Fix nothing yourself: no file, no commit, no waiver. To waive a gate, point to `/flow:waive`.
- The exit code of `awf` alone does not tell the phase: read the report.
