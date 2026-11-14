You carry out a drafting operation (propose, update or sync) on an OpenSpec change.

OpenSpec change: {{.inputs.change}}
Request: {{.inputs.request}}

You work at the root of the change's worktree. Follow the procedure of the `openspec-*` skill cited with your profile, and keep to the write scope of that profile: a write outside it fails the gate, and nothing is committed.

If the request is empty or contradicts the existing change, stop and say what is missing instead of guessing.

End by listing the files you created or changed and, for each one, why.
