# openspec-tdd

An [AWF](https://github.com/awf-project/cli) workflow pack that applies [OpenSpec](https://github.com/Fission-AI/OpenSpec)
changes test first. Each code slice of a change's `tasks.md` goes through RED, GREEN and a review whose tools come from
your project's language registry. The change is then reviewed as a whole, checked against its Definition of Done and
merged. Drafting, spec sync, acceptance and archiving of changes are part of the pack.

Moving from one phase to the next depends on the exit codes of your tools (test runner, static analysis, mutation
testing), never on what the agent reports.

## Requirements

- awf 0.11.9 or later
- git, bash, jq, and `flock` (util-linux) for parallel tasks
- Node.js 24 or later (the task parser is TypeScript run by Node)
- the `openspec` CLI
- an agent CLI that awf can drive, Claude Code by default

## Install

From a GitHub release:

```bash
awf workflow install gplanchat/awf-workflow-openspec-tdd
```

Add `--global` to install it for every project, or `@0.1.0` to pin a version. Then check the installation:

```bash
awf workflow info openspec-tdd
```

## Configure your project

The pack calls no project tool directly. It reads two files at the root of your repository.

| File | Required | Content |
|---|---|---|
| `.awf/languages.yaml` | yes | The language registry: for each language key, the slice workflow, the test file patterns, and the commands for RED, GREEN, each review tool and the merge checks. |
| `.awf/commands.yaml` | no | The command contract: replaces the git defaults for worktrees, claims, merges, parallel runs and end-to-end tests. |

Start from the examples:

- [`examples/languages.yaml`](examples/languages.yaml): PHP, TypeScript, Three.js and Go entries
- [`examples/languages-rust.yaml`](examples/languages-rust.yaml): Rust entries, one key per RED level, plus performance slices
- [`examples/commands.yaml`](examples/commands.yaml): a project driven by its own stack script

The operations of the command contract and their git defaults are listed at the top of
[`scripts/commands.sh`](scripts/commands.sh).

To run the same merge checks when you merge by hand, install the git hook:

```bash
bash <pack>/scripts/merge-gate.sh install
```

## Write tasks the pack can apply

A code task in `tasks.md` is declared in slices. The tag in brackets is a key of `.awf/languages.yaml`:

```markdown
## 2. Order total

- [ ] 2.1 Compute the order total
  - [ ] 2.1.1 [php] The total sums the lines, taxes included
  - [ ] 2.1.2 [ts] The cart page shows the total
```

- A slice tagged `[critical]` next to its language gets the extra review tools of `critical_steps`.
- A group whose title ends with `(parallel)` runs its tasks at the same time, each in its own sub-worktree, when
  `max_tasks` is above 1.
- A task without slices is a manual task: an agent carries it out, and its `Verified by:` command decides whether its
  box gets checked.
- Each criterion of the Definition of Done carries its check command, or `Manual`.

## Workflows

Run a workflow with `awf run openspec-tdd/<workflow>`. The usual entry points:

| Workflow | Purpose |
|---|---|
| `flow-propose` | Drafts a new change (proposal, specs, design, tasks) in `.worktrees/propose-<change>`. |
| `flow-update` | Revises the artifacts of an existing change. |
| `flow-accept` | Accepts a change: writes `acceptance.yaml` and merges the proposal. |
| `flow-apply` | Applies a change in `.worktrees/<change>` through `apply-change`. |
| `apply-many` | Applies several changes in parallel, then merges them one by one into main. |
| `flow-sync` | Carries the deltas of a change into the main specs. |
| `flow-archive` | Replays the Definition of Done and archives the change. |
| `flow-waive` | Records your waiver of a failed gate for a change, 30 days at most. Run it from your terminal. |
| `flow-explore` | Prints the repository context (`step=start`) and checks that an exploration session wrote nothing under `openspec/` (`step=finish`). |

Building blocks, called by the workflows above:

| Workflow | Purpose |
|---|---|
| `apply-change` | Applies the open tasks of a change in order, then runs the final reviews and `dod-verify`. |
| `apply-task` | Applies one task, slice by slice. |
| `tdd-slice-php`, `tdd-slice-ts`, `tdd-slice-threejs`, `tdd-slice-go`, `tdd-slice-rust` | One TDD slice: RED, GREEN, review. |
| `tdd-slice-rust-perf` | One performance slice, measured against a benchmark target. |
| `free-task` | One manual task. |
| `review` | The review tools of one language, in order. |
| `dod-verify` | The Definition of Done criteria, one command each. |
| `flow-gate`, `flow-commit` | Gates and commit shared by the drafting workflows. |

Each workflow writes its report under `.awf/status/`. Each one describes its inputs and exit codes in its
`description` field; `awf workflow info openspec-tdd` lists them.

## Add a language

1. Add an entry to `.awf/languages.yaml` with the commands of your toolchain.
2. Point its `workflow` at an existing `tdd-slice-*` workflow, or add one to the pack with its prompts in `prompts/`
   and its skill in `skills/`.

## Known limitations

- The pack needs awf 0.11.9 or later: with 0.11.8 and earlier, `call_workflow` to a workflow of a pack fails
  ([awf-project/cli#426](https://github.com/awf-project/cli/issues/426)).
- The `[critical]` tag is honoured by the PHP, TypeScript, Go and Rust slice workflows, not by `tdd-slice-threejs`.
- `max_total` caps only the tasks of `(parallel)` groups; sequential tasks are not counted.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
