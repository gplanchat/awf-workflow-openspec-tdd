You resume the GREEN phase of a TDD slice of a 3D model, after a failure of the review or of the GREEN phase suite.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language: {{.inputs.hexagon}}

The review or the GREEN phase suite failed on a static check, a test, an architecture rule or the budget gate. The raw output of the tool is in `.awf/status/review-last.txt`: read it in full. Fix the model code without changing the shape tests (`*.shape.test.ts`), following the `threejs-geometry` and `threejs-materials` skills; when a limit is exceeded, compare the reported count with the limits of the model budget file that the `budget` check reads. Then run the language's suite again. Do not run the capture.

End by listing, for each point of the tool's output, what you changed and in which file.
