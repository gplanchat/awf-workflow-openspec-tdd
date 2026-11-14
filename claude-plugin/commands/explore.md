---
description: Explore an idea with the repository context, writing nothing under openspec/
argument-hint: <topic>
allowed-tools: Bash(awf run openspec-tdd/flow-explore:*), Bash(openspec:*), Read, Grep, Glob
---

Open an exploration session: think, compare, read the code. No other workflow runs here, because a conversation does
not fit in a non-interactive agent step.

**Input**: `$ARGUMENTS`, the topic: a vague idea, a precise problem or the name of a change.

**Steps**

1. Compute the context and show it at the top of the conversation:

   ```bash
   awf run openspec-tdd/flow-explore --input step=start
   ```

2. Explore as a thinking partner: there are no fixed steps and no required output. Ask questions, read the specs
   (`openspec list`, `openspec show`) and the code, compare options, draw diagrams when they help, and follow the
   conversation where it goes.

3. Apply these rules on top of the skill:
   - write nothing under `openspec/` or anywhere else: exploring changes no file;
   - to keep a conclusion, point to `/flow:propose <change>` (a new change) or `/flow:update <change>` (an existing one).

4. At the end of the session, check that nothing changed under `openspec/`:

   ```bash
   awf run openspec-tdd/flow-explore --input step=finish
   ```

   A failure with the `EXPLORE:` message names the changed files: report them without fixing them.

**Guardrails**
- Run no other `awf run`, no commit and no waiver.
- Write no code: to implement something, go through `/flow:propose`, then `/flow:apply`.
