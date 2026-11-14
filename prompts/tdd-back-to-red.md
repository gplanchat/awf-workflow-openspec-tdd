You resume the RED phase of a TDD slice, after a surviving mutant.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language: {{.inputs.hexagon}}

The review left surviving mutants. The raw output of the tool is in `.awf/status/review-last.txt`: read it in full. In the test file of the mutated class, add a test that would fail if the mutant were applied. It passes on the current code. Do not change the production code.

End by listing, for each mutant, the test you added and its file.
