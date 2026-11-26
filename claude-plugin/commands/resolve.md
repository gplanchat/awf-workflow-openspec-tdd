---
description: Work through the findings of the EGM review of a change with you, then apply the approved fixes through flow-resolve and review again
argument-hint: <change>
allowed-tools: Bash(awf run openspec-tdd/flow-resolve:*), Bash(awf run openspec-tdd/flow-review:*), Bash(AWF_WORKFLOWS_PATH=* awf resume:*), Bash(cat:*), Bash(ls:*), Read, Grep, Glob
---

Resolve the findings of an EGM review: for each finding, you propose a fix or contest it, the user decides, and the
approved fixes go to `flow-resolve`, which hands them to `flow-update`, whose gates and commit apply as for any revision. The change is then reviewed again.

**Input**: `$ARGUMENTS`, the name of the change.

**Steps**

1. Check that the input gives a change name in kebab-case. If it is missing, stop and ask for it. Invent no name.

2. Read `.awf/status/egm/review.md` where the change is drafted (`.worktrees/propose-<change>` when that folder
   exists, otherwise the root of the repository). Without it, point to `/flow:review <change>` and stop.

3. Find the EGM plugin: `$EGM_ROOT` when it is set, otherwise the last folder that
   `ls -d ~/.claude/plugins/cache/egm/egm/*/ | sort -V` lists. Without one, stop and point to `/flow:setup`.

4. Read `<EGM>/skills/egm-resolve/SKILL.md` and follow it on the findings of `review.md`, Blockers first, with these
   differences:
   - edit no file yourself: write each approved fix as one line of a list;
   - the document under review is the change: `proposal.md`, `design.md`, `specs/` and `tasks.md` of
     `openspec/changes/<change>/`.

5. When at least one fix is approved, run, in the same folder, with the list as the description:

   ```bash
   awf run openspec-tdd/flow-resolve --input change=<change> --input fixes="<approved fixes>"
   ```

   Give the report of `.awf/status/flow-update.json`. If the workflow fails, show its failed phase and stop.

6. Review the change again: read `${CLAUDE_PLUGIN_ROOT}/commands/review.md` and follow its steps 2 to 5.

**Guardrails**
- Apply only the fixes the user approved, and only through `flow-resolve`.
- No commit and no waiver outside the workflows.
