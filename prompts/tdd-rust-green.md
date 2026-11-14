You run the GREEN phase of a TDD slice in Rust.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language key: {{.inputs.hexagon}}

The RED phase left a failing test, and possibly `todo!()` stubs. Write the minimum production code that makes it pass, without changing the tests, then run the full test suite of the language (`test` in `.awf/languages.yaml`).

End with the production files created or changed. The REVIEW phase follows.
