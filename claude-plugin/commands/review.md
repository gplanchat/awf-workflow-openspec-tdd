---
description: Review a drafted OpenSpec change with the EGM reviewers through the flow-review workflow, and put the Blockers to you
argument-hint: <change>
allowed-tools: Bash(awf run openspec-tdd/flow-review:*), Bash(AWF_WORKFLOWS_PATH=* awf resume:*), Bash(cat:*), Bash(ls:*), Read
---

Review a drafted change with the Elephant-Goldfish Model (EGM): `flow-review` gives the change to seven reviewers of
the EGM plugin, each a fresh agent with no earlier context and read-only tools. `proposal.md`, `design.md` and `specs/`
form the feature part, `tasks.md` the implementation plan. The findings go to `.awf/status/egm/review.md`.

**Input**: `$ARGUMENTS`, the name of the change.

**Steps**

1. Check that the input gives a change name in kebab-case. If it is missing, stop and ask for it. Invent no name.

2. Run the workflow where the change is drafted: in `.worktrees/propose-<change>` when that folder exists, otherwise
   at the root of the repository.

   ```bash
   awf run openspec-tdd/flow-review --input change=<change>
   ```

3. Read `.awf/status/flow-review.json` in the same folder.
   - `clean`: give the number of Majors and Nits and the path of `review.md`. The change can go to `/flow:accept`.
   - `waiting`: the review found Blockers. Go to step 4.

4. Read `.awf/status/egm/review.md` and show each Blocker as the report writes it, an `issue (blocking)` Conventional
   Comment with its scope, its reviewer and the recommendation. Then ask the
   user one question, with these three answers:
   - `proceed`: accept the change with these Blockers;
   - `revise`: fix them, then review again (`/flow:resolve <change>`);
   - `abandon`: drop the change.

   Run the line of the workflow output that starts with `To answer:`, without that prefix, with `<answer>` replaced
   by the user's answer. Read `.awf/status/flow-review.json` again and give its status: `accepted`, `revise` or
   `abandoned`. For `revise`, point to `/flow:resolve <change>`.

5. If the workflow fails before the review (awf exits with code 3 for every failure; the message tells them apart):
   - the change is not in this folder or EGM is missing: quote the message, and point to `/flow:setup` for EGM;
   - "An EGM reviewer failed": a reviewer failed or answered without valid findings; show the content of the
     `.awf/status/egm/<reviewer>.err` file, for the first reviewer that has no `<reviewer>.json`.

**Guardrails**
- The decision belongs to the user: never answer the question yourself, and never resume without an answer.
- Edit no file of the change: fixing the findings goes through `/flow:resolve`.
