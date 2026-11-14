---
description: Install what the /flow:* commands need (awf, the openspec-tdd pack, and zpm when the project records pass proofs)
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh report)
---

Install what the /flow:* commands need: awf in the version the pack requires, the `.awf/` folder of the project, the
openspec-tdd pack in the version the plugin calls, and zpm when `.awf/languages.yaml` lists pass proofs (a non-empty
`proofs` key).

The check of the current repository:

!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh report`

**Steps**

1. If the check reads "Nothing is missing.", say so and stop.

2. Otherwise each line names a missing item and ends with `Fix: <command>`. Show the list, then run the `Fix:` commands one
   at a time, in the order of the list. Each command asks for the user's permission: when the user declines one, skip
   it and go on with the next. When a command fails, quote its message and stop.

3. Run the command of the first line of the check (`Check again with: ...`) and give its result. If `awf` or `zpm`
   was installed in a folder that is not in the PATH, the install command says so: repeat that line.

**Guardrails**
- Run only the check and the `Fix:` commands it prints, unchanged.
- Do not install anything the check does not list, and do not edit any file yourself.
