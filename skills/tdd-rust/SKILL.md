---
name: tdd-rust
description: Rust conventions of the TDD slices - test levels, test file layout, RED stubs, errors, review tools.
---

# Rust conventions of a TDD slice

Applies to slices whose language key runs `tdd-slice-rust` or `tdd-slice-rust-perf` (for instance `[rust-unit]`,
`[rust]`, `[rust-integration]`, `[rust-perf]`). The commands of each level come from `.awf/languages.yaml`; read the
entry of the slice's key before running anything.

## Test levels

| Level | Where | Constraint |
|---|---|---|
| unit | `src/<module>/tests.rs` or `src/<module>_tests.rs`, loaded by `#[cfg(test)] mod tests;` | no I/O |
| functional | a test module of the crate, use cases with in-memory test doubles | no I/O |
| integration | `tests/*.rs` | real I/O; contracts against a real service sit behind a cargo feature and stay out of the gates |
| e2e | the built binary, driven from outside (`assert_cmd`, `trycmd`, `insta` for outputs) | |
| perf | `criterion` for time, `iai-callgrind` for a deterministic instruction count | |

Unit tests live in a file of their own, never inline in the production file. The gates tell test files from production
files by path: a `#[cfg(test)] mod tests { ... }` block inside a production file is invisible to them.

## Commands that run in parallel

Slices of different tasks run at the same time in separate worktrees. A level command writes only to paths of its own
worktree or process (`target/`, a folder under the worktree, `mktemp`), never to a fixed shared path such as `/tmp/x`:
two runs sharing a folder overwrite each other's files and the counts of both become wrong.

## RED

- One test per spec scenario the slice covers, named after its behaviour.
- The test must compile. A compilation error writes no JUnit report, and the gate does not count it as RED.
- Add only the production signatures the test needs, with a `todo!()` body. The panic of `todo!()` is a valid RED
  failure. No other production code in RED.

## GREEN

The minimum code that makes the RED test pass. Do not change the tests. Replace every `todo!()` the slice added.

## Errors

- Return an error type of the project, named after the problem (an enum variant or a struct implementing
  `std::error::Error`), that the test matches with `matches!` or by variant. No `String` or `Box<dyn Error>` as a
  contract error.
- An error from another layer keeps its cause through `source()`.
- The `Display` message carries no interpolated data: context goes into typed fields of the error.
- No `unwrap()` or `expect()` in production code outside `main` and tests.

## Review

The tools run in the order of `review_steps`: usually `fmt`, `clippy`, `unit`, `functional`, `integration`, then
optionally `mutants`, `e2e` and `perf`. A failure of `mutants` (a missed mutant) sends the slice back to RED: add a test
that fails if the mutant is applied. Any other failure sends it back to GREEN.

## Critical slices

A slice tagged `[critical]` next to its language tag realises a scenario marked `critical: <category>` under its
`#### Scenario:` heading (data-loss, data-leak, revenue, reputation, safety). For such a slice:

- RED writes, for each critical scenario of the change, a test carrying `// scenario: <exact title>`. A renamed
  scenario breaks the link on purpose.
- The review adds `critical_steps` and `required` (usually `harness`, `trace`, `mutants`). None of them can be skipped.
- The harness checks invariants with `proptest`, hostile input with a time-boxed `cargo fuzz` run (every crash found
  becomes a regression test), faults (failing I/O, full disk, interrupted write, retry, replay) with proof that no data
  is lost or duplicated, and concurrency with `loom` or unsafe code with `cargo miri test` where they apply.

## Known limits

- `harness_merge` in `merge_checks` runs on every merge that touches the language folder, not only on merges that
  contain a critical slice. Narrowing it to critical merges is the planned next step.
- In a performance slice, any review failure goes back to the optimizing agent, which may not change tests. A missed
  mutant there uses up the three turns and stops the slice.
