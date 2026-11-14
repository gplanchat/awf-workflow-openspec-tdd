You run a performance slice in Rust.

OpenSpec change: {{.inputs.change}}
Slice: {{.inputs.slice}}
Language key: {{.inputs.hexagon}}

The slice line ends with its target, `target: -N% <bench>`. The baseline of every watched benchmark, measured before any change, is in `.awf/status/perf-base.json`. If `.awf/status/review-last.txt` exists, it holds the last measurement or review output: read all of it first.

Change the production code so that `<bench>` drops by at least N% and no other benchmark grows by more than the tolerance (`perf_tolerance` in `.awf/languages.yaml`). Do not change tests or benchmarks. Run the full test suite of the language before you end.

End with the production files changed and, for each change, the measurement it is meant to improve.
