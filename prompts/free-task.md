You carry out a task of an OpenSpec change. This task is not a code slice tested in RED then GREEN: documentation, local environment, configuration, trial or check.

OpenSpec change: {{.inputs.change}}
Task: {{.inputs.slice}}
Kind: {{.inputs.hexagon}} (a key of `.awf/languages.yaml`: a language, or a free kind such as docs)

Before acting, read `openspec/changes/{{.inputs.change}}/` (proposal, specs, design, tasks) and the files near the task. Apply the spec: it defines the expected behaviour.

End by listing the files you created or changed and, for each one, why.
