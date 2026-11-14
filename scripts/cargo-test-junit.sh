#!/usr/bin/env bash
# Writes a JUnit report from the text output of `cargo test` on stable Rust: cargo-test-junit.sh <report> < output
#   cargo test --lib 2>&1 | bash cargo-test-junit.sh target/gate-red.xml
# Reads the `test <path> ... ok|FAILED|ignored` lines and takes the failure message from the
# `---- <path> stdout ----` blocks. A compilation error prints no `test` line: no report is written and the script exits
# with 1, so the RED gate does not count it as a failing test.
set -euo pipefail
report=${1:?usage: cargo-test-junit.sh <report>}
mkdir -p "$(dirname "$report")"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

awk '
  function esc(s) { gsub(/&/, "\\&amp;", s); gsub(/</, "\\&lt;", s); gsub(/>/, "\\&gt;", s); gsub(/"/, "\\&quot;", s); return s }
  /^test .* \.\.\. (ok|FAILED|ignored)/ {
    name = $2; status = $NF
    if (!(name in state)) order[++n] = name
    state[name] = status
    next
  }
  /^---- .* stdout ----$/ { current = $2; next }
  /^(failures:|---- )/ { current = ""; }
  current != "" { message[current] = message[current] $0 "\n" }
  END {
    if (n == 0) exit 1
    for (i = 1; i <= n; i++) { t = state[order[i]]; if (t == "FAILED") f++; else if (t == "ignored") s++ }
    printf "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    printf "<testsuites tests=\"%d\" failures=\"%d\" errors=\"0\" skipped=\"%d\">\n", n, f, s
    printf "  <testsuite name=\"cargo test\" tests=\"%d\" failures=\"%d\" errors=\"0\" skipped=\"%d\">\n", n, f, s
    for (i = 1; i <= n; i++) {
      name = order[i]; t = state[name]
      printf "    <testcase name=\"%s\" classname=\"cargo\"", esc(name)
      if (t == "ok") { printf "/>\n"; continue }
      if (t == "ignored") { printf "><skipped/></testcase>\n"; continue }
      printf "><failure message=\"test failed\">%s</failure></testcase>\n", esc(message[name])
    }
    printf "  </testsuite>\n</testsuites>\n"
  }
' >"$tmp" || { echo "cargo-test-junit: no test result in the cargo test output (compilation error?)." >&2; exit 1; }
mv "$tmp" "$report"
trap - EXIT
