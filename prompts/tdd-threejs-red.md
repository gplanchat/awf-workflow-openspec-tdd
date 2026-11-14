You carry out the RED phase of a TDD slice of a 3D model.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language: {{.inputs.hexagon}} (Three.js shape tests)

Before writing, read `openspec/changes/{{.inputs.change}}/` (proposal, specs, design, tasks), the code near the slice and the `threejs-geometry` and `threejs-materials` skills. List the scenarios of the spec that the slice covers: one test per scenario, named after its behaviour.

Write shape tests, in `*.shape.test.ts` files. Read the triangle and material limits of the model's family in the model budget file that the `budget` check reads; do not copy them. Do not run the capture.

End by giving the test file you created, the list of spec scenarios it covers (exact titles) and the exact reason for the failure you observed.

The gate then runs only the new or changed `.shape.test.ts` files and reads the test report: a startup or configuration failure does not count as a test failure.
