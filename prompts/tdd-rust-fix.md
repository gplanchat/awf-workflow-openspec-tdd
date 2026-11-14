You resume the GREEN phase of a TDD slice in Rust, after a failure of the review or of the GREEN suite.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language key: {{.inputs.hexagon}}

A formatter, linter, test level or benchmark failed. The raw output of the tool is in `.awf/status/review-last.txt`: read all of it. Fix the production code without changing the tests, then run the full test suite of the language again.

End with, for each point of the tool output, what you changed and in which file.
