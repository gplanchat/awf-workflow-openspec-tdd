---
description: Record, on your request, a waiver of a gate for a change (30 days at most)
argument-hint: <change> <gate> --reason "<reason>" [--days N]
allowed-tools: Bash(awf run openspec-tdd/flow-waive:*)
---

Record a waiver of a gate of a `flow-*` workflow. A waiver is your decision: this command only records it.

**Input**: `$ARGUMENTS`, in the form `<change> <gate> --reason "<reason>" [--days N]`. The reason is required.
`--days` can only shorten the 30 days by default (from 1 to 30).

**Steps**

1. Check that the input gives the change, the gate and a reason. If one is missing, stop and ask for it. Invent
   neither a reason nor a duration.

2. Run the workflow, which writes the waiver registry through flow.sh:

   ```bash
   awf run openspec-tdd/flow-waive --input change=<change> --input gate=<gate> --input reason="<reason>" [--input days=<N>]
   ```

3. Show the line it prints (change, gate, expiry date). A failure with the `WAIVER:` message means invalid input:
   quote the message and do not retry.

**Guardrails**
- Create a waiver only when the user asks for it in this message. Never infer one from a failed gate.
- Never write the registry any other way: a hook blocks it.
- A waived gate passes marked as waived, and each use is logged; remind the user of the expiry date.
