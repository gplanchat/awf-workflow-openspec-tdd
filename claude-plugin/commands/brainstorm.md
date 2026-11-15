---
description: Explore an idea with EGM goldfish reviewers and write a concepts brief that /flow:propose drafts the change from
argument-hint: <change> <idea>
allowed-tools: Bash(awf run openspec-tdd/flow-explore:*), Bash(openspec:*), Bash(ls:*), Read, Grep, Glob, Write(.awf/briefs/**)
---

Turn an idea into a concepts brief with the Elephant-Goldfish Model (EGM): you hold the context of the project and of
the conversation, fresh reviewers challenge the idea, and the agreed direction goes to `.awf/briefs/<change>.md`.
`/flow:propose <change>` then drafts the change from that brief.

**Input**: `$ARGUMENTS`, the name of the future change in kebab-case, then the idea.

**Steps**

1. Check that the input gives a change name in kebab-case. If it is missing, stop and ask for it. Invent no name.

2. Compute the context of the repository and show it:

   ```bash
   awf run openspec-tdd/flow-explore --input step=start
   ```

3. Find the EGM plugin: `$EGM_ROOT` when it is set, otherwise the last folder that
   `ls -d ~/.claude/plugins/cache/egm/egm/*/ | sort -V` lists. Without one, stop and point to `/flow:setup`.

4. Read `<EGM>/skills/egm-brainstorm/SKILL.md` and follow it, with these differences:
   - write the brief to `.awf/briefs/<change>.md`, not to `concepts_brief.md`;
   - read the specs with `openspec list` and `openspec show` when the idea touches an existing capability;
   - write nothing under `openspec/`, and no code.

5. Check that nothing changed under `openspec/`:

   ```bash
   awf run openspec-tdd/flow-explore --input step=finish
   ```

6. Give the path of the brief and point to `/flow:propose <change>`.

**Guardrails**
- Run no other workflow, no commit and no waiver.
- Write only `.awf/briefs/<change>.md`.
