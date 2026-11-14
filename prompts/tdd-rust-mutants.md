You resume the RED phase of a TDD slice in Rust, after missed mutants.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language key: {{.inputs.hexagon}}

The review left missed mutants. The raw output of `cargo mutants` is in `.awf/status/review-last.txt`: read all of it. For each missed mutant, add a test that would fail if the mutant were applied. It passes on the current code. Do not change production code.

End with, for each mutant, the test added and its file.
