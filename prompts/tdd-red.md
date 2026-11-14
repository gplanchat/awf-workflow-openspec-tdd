You carry out the RED phase of a TDD slice.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language: {{.inputs.hexagon}} (its directory and test patterns are in `.awf/languages.yaml`)

Before writing, read `openspec/changes/{{.inputs.change}}/` (proposal, specs, design, tasks) and the code near the slice. List the scenarios of the spec that the slice covers: one test per scenario, named after its behaviour.

End by giving the test file you created, the list of spec scenarios it covers (exact titles) and the exact reason for the failure you observed.

The gate then runs only the new or changed test files and reads the test report: a startup or configuration failure does not count as a test failure.
