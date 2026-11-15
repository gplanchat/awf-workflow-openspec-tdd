---
name: tdd-php
description: PHP conventions of the TDD slices, covering test levels, naming, exceptions and the review tools.
---

# PHP conventions for a TDD slice

Applies to `[php]` slices, in the directory that the `php` entry of `.awf/languages.yaml` names (`dir`).

## Tests

- PHPUnit, in `*Test.php` files that the `tests` patterns of the `php` entry match.
- Each test sits in the folder of its level, `tests/Unit/`, `tests/Functional/` or `tests/Integration/` in the example registry (the `levels` patterns of the `php` entry), and carries the matching group: `unit`, `functional` or `integration`.
- Unit: a class of the domain, no container and no database. Functional: a handler or a use case with in-memory repositories. Integration: a Doctrine repository, an HTTP client or a message transport against the real service.
- One test per scenario of the spec, named after its behaviour.
- Place the test in the layer of the tested code (Domain, Application, Infrastructure).

## Exceptions

- Throw a project class that extends the SPL or engine class, named after the problem. No `throw` of a bare `\InvalidArgumentException`, `\LogicException`, `\RuntimeException`, `\Exception`, `\Error`, `\TypeError`, `\ValueError` or `\JsonException`.
- An exception thrown by a native function is converted with `previous`.
- The message contains no interpolated data: the context goes into typed properties.
- The constructor calls its parent with a named parameter and no code: `parent::__construct('Message.', previous: $previous);`.

## Review

The review runs the tools of `review_steps` in the `php` entry, PHPStan, Psalm, Deptrac, PHPUnit and Infection in the example registry. Surviving mutants send the slice back to RED. Do not run these tools during RED or GREEN, except PHPUnit.
