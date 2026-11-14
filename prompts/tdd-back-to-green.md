You resume the GREEN phase of a TDD slice, after a failure of the review or of the GREEN phase suite.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language: {{.inputs.hexagon}}

The review or the GREEN phase suite failed on a static check, a test or an architecture rule. The raw output of the tool is in `.awf/status/review-last.txt`: read it in full. Fix the production code without changing the tests, then run the language's suite again.

End by listing, for each point of the tool's output, what you changed and in which file.
