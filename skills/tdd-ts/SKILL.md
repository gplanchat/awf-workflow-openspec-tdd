---
name: tdd-ts
description: TypeScript conventions of the TDD slices, covering test levels, naming, exceptions and the review tools.
---

# TypeScript conventions for a TDD slice

Applies to `[ts]` slices, in the directory that the `ts` entry of `.awf/languages.yaml` names (`dir`).

## Tests

- Vitest, in `*.test.ts` files that the `tests` patterns of the `ts` entry match.
- The level shows in the suffix: `.unit.test.ts`, `.functional.test.ts` or `.integration.test.ts`.
- One test per scenario of the spec, named after its behaviour.
- Place the test in the layer of the tested code (domain, application, infrastructure).

## Exceptions

- Throw a project subclass of `Error`, named after the problem. No `throw` of a string, an object, a bare `Error` or a native class (`TypeError`, `RangeError`, `SyntaxError`).
- An error thrown by the engine or a native API (the `SyntaxError` of `JSON.parse`) is converted with `cause`.
- The message contains no interpolated data: the context goes into typed properties.

## Review

The review runs the tools of `review_steps` in the `ts` entry, `tsc`, ESLint, dependency-cruiser, Vitest and Stryker in the example registry. Surviving mutants send the slice back to RED. Do not run these tools during RED or GREEN, except Vitest.
