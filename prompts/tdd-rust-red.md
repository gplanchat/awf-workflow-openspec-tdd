You run the RED phase of a TDD slice in Rust.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language key: {{.inputs.hexagon}} (its RED level and commands are in `.awf/languages.yaml`)

Before writing, read `openspec/changes/{{.inputs.change}}/` (proposal, specs, design, tasks) and the code around the slice. List the spec scenarios the slice covers: one test per scenario, named after its behaviour.

Write the tests at the level the language key declares (unit tests in a separate `tests.rs` or `<module>_tests.rs` file loaded by `#[cfg(test)] mod tests;`, integration tests in `tests/`). The test must compile: add the production signatures it needs with a `todo!()` body and nothing else.

Critical slice: {{.inputs.critical}}. When it is "true", every scenario of the change marked `critical:` in its spec needs a test carrying the comment `// scenario: <exact scenario title>`, and the gate checks it before GREEN.

End with the test files created, the spec scenarios covered (exact titles) and the exact reason the test fails.

The gate then runs the RED command of the language key and reads its JUnit report. A compilation error writes no report and does not count as RED.
