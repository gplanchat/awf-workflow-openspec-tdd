{{.states.brief.Output}}

Answer with a single JSON object and nothing else, in this shape:

{"findings": [{"severity": "Blocker", "scope": "<file>:<lines> or subsystem", "finding": "<the flaw or gap>", "recommendation": "<what to change>"}]}

With no finding, answer {"findings": []}.
