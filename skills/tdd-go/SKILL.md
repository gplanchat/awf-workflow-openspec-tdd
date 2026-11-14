---
name: tdd-go
description: Go conventions of the TDD slices, covering tests, naming, errors and the review tools.
---

# Go conventions for a TDD slice

Applies to `[go]` slices, in the directory that the `go` entry of `.awf/languages.yaml` names (`dir`).

## Tests

- The `testing` package, in `*_test.go` files next to the tested code.
- Table-driven tests (`[]struct{...}` and `t.Run`) when several cases share a behaviour; one subtest per scenario of the spec, named after its behaviour.
- In RED, a test that calls a function or type that does not exist yet does not compile, and the gate counts a build error as a test that could not run (code 12), not as a failing test. Declare the missing function or type with its final signature and a body that returns zero values, so that the test compiles and fails on its assertion.

## Errors

- Return a typed project error, named after the problem, that the test compares with `errors.Is` or `errors.As`. No anonymous `errors.New` or `fmt.Errorf` as a contract error.
- An error from another layer is wrapped with `%w` to keep the cause.
- The message contains no interpolated data: the context goes into the fields of the error type.

## Review

The review runs the tools of `review_steps` in the `go` entry, `go vet` then `go test -race` in the example registry. Go has no mutation testing there, so the review never sends the slice back to RED.
