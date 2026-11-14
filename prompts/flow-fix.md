You fix an OpenSpec change after a gate failed.

OpenSpec change: {{.inputs.change}}
Fix attempt: {{.loop.Index1}} of 3

The names of the failed gates are in `.awf/status/flow-gate.failed` and their raw output in `.awf/status/flow-gate.log`: read both in full before acting. Fix the cause of each gate without leaving the write scope of your profile. Do not check any box of `tasks.md`, and touch neither `.awf/status/` nor the waiver registry.

End by listing, for each failed gate, what you changed and in which file.
