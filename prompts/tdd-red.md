You carry out the RED phase of a TDD slice.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language: {{.inputs.hexagon}} (its directory and test patterns are in `.awf/languages.yaml`)
Test level: {{.inputs.level}}

Before writing, read `openspec/changes/{{.inputs.change}}/` (proposal, specs, design, tasks) and the code near the slice. List the scenarios of the spec that the slice covers: one test per scenario, named after its behaviour.

Write every test at the test level above, in a file that the `levels` pattern of that level matches in `.awf/languages.yaml`: the gate fails on a test file at another level. When the level is empty, choose it with the level rules of your profile, and follow the test strategy of `design.md` when it gives one.

End by giving the test file you created, the list of spec scenarios it covers (exact titles) and the exact reason for the failure you observed.

The gate then runs only the new or changed test files and reads the test report: a startup or configuration failure does not count as a test failure.
