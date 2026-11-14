# Contributing to openspec-tdd

Bug reports, fixes and new languages are welcome. This page explains how the pack is laid out, how to run its tests
and what a pull request needs.

## Report a bug

Open an issue with:

- the awf version (`awf --version`) and the pack version (`awf workflow info openspec-tdd`);
- the workflow you ran and its inputs;
- the report it wrote under `.awf/status/`, and the relevant part of your `.awf/languages.yaml`.

Remove anything private from the registry and the reports before you paste them.

## Layout

| Directory | Content |
|---|---|
| `workflows/` | The AWF workflows, one YAML file each, listed in `manifest.yaml`. |
| `scripts/` | The shell and TypeScript steps the workflows call, and their tests (`*.test.mts`). |
| `prompts/` | The prompts given to the agent at each phase. |
| `skills/` | The skills the agent loads during a phase. |
| `hooks/` | The git hook that `merge-gate.sh install` activates. |
| `examples/` | Registry and command contract examples for projects. |

Keep each workflow a sequence of steps and put each computation in a script subcommand that returns an exit code. A
script can then be tested on its own, on a throwaway git repository.

## Run the tests

The tests use the Node.js test runner and need Node.js 24 or later, git, bash, jq and flock:

```bash
XDG_DATA_HOME="$(mktemp -d)" node --test scripts/*.test.mts
```

`XDG_DATA_HOME` points awf at an empty history database, so that runs from your other projects do not interfere.
The suites use the test registry in `scripts/fixtures/project/.awf/languages.yaml`.

After you change a file under `workflows/`, also run `awf validate` on that workflow.

## Write a change

- Write code, comments, prompts and documentation in English.
- Keep the pack generic: no project name, path or tool that only one project uses. A project-specific command belongs
  in `.awf/languages.yaml` or `.awf/commands.yaml`, and the pack reads it from there.
- Add or update a test for any change to a script.
- Bump `version` in `manifest.yaml` when a change alters the inputs, outputs or exit codes of a workflow.
- Error messages say what failed, why, and what to do next.

## Open a pull request

1. Fork the repository and create a branch from `main`.
2. Make your change with its tests, and check that every suite passes.
3. Describe what the change does and why, and how you tested it. Link the issue it fixes, if any.

You keep the copyright on your contribution. By submitting it, you agree to license it under the Apache License 2.0,
as section 5 of [the license](LICENSE) provides.
