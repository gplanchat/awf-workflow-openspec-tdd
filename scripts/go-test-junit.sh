#!/usr/bin/env bash
# Writes a JUnit report from the output of `go test -json`: go-test-junit.sh <report> < output
#   go test -json ./cart 2>&1 | bash go-test-junit.sh reports/gate-red.xml
# Reads the pass, fail and skip events of each test, subtests included, and takes the failure message from the output
# events of the failing test. A package that fails without a failing test did not build or start (a test that calls a
# function that does not exist yet does not compile): no report is written and the script exits with 1, as when no test
# ran at all, so the RED gate does not count it as a failing test.
set -euo pipefail
report=${1:?usage: go-test-junit.sh <report>}
mkdir -p "$(dirname "$report")"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# Lines that are not JSON (a toolchain message on stderr) are skipped.
jq -rRs '
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;") | gsub("\""; "&quot;");
  [split("\n")[] | fromjson? | objects] as $events
  | [$events[] | select(.Test != null and (.Action == "pass" or .Action == "fail" or .Action == "skip"))] as $results
  | ($results | map(select(.Action == "fail") | .Package) | unique) as $failing
  | [$events[] | select(.Test == null and .Action == "fail") | .Package | select(. as $p | $failing | index($p) | not)]
    as $broken
  | if ($broken | length) > 0 then
      "go-test-junit: the package \($broken | join(", ")) failed without a failing test (build error?).\n" | halt_error(1)
    elif ($results | length) == 0 then
      "go-test-junit: no test result in the go test -json output.\n" | halt_error(1)
    else . end
  | (reduce ($events[] | select(.Action == "output" and .Test != null)) as $e
      ({}; .[$e.Package + " " + $e.Test] += $e.Output)) as $output
  | ($results | map(select(.Action == "fail")) | length) as $f
  | ($results | map(select(.Action == "skip")) | length) as $s
  | ($results | length) as $n
  | "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<testsuites tests=\"\($n)\" failures=\"\($f)\" errors=\"0\" skipped=\"\($s)\">",
    "  <testsuite name=\"go test\" tests=\"\($n)\" failures=\"\($f)\" errors=\"0\" skipped=\"\($s)\">",
    ($results[]
      | "    <testcase name=\"\(.Test | esc)\" classname=\"\(.Package | esc)\""
        + if .Action == "pass" then "/>"
          elif .Action == "skip" then "><skipped/></testcase>"
          else "><failure message=\"test failed\">\($output[.Package + " " + .Test] // "" | esc)</failure></testcase>"
          end),
    "  </testsuite>",
    "</testsuites>"
' >"$tmp"
mv "$tmp" "$report"
trap - EXIT
