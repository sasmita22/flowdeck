---
name: analyze-job
description: How to list what one Agent node needs from its instructions alone - its inputs, outputs, tools and the procedures it repeats - and record them in build-report.json needs, so the agent is written from that list and shared needs can be found. Read before write-agent, for every agent piece of a Flowdeck build.
---

# Analyze the Job

An Agent node's instructions say what the agent does. Before the agent is written, list what that job needs, so `write-agent` writes the agent from the list and `extract-shared` can find what several agents need alike.

## Steps

1. Find the piece's nodes in `manifest.json`: every node whose `file` is the piece's path. A merged piece serves several nodes; analyze each one.
2. For each node, read its `settings` (`role`, `instructions`, `given`, `writes`, `produces`, `tools`).
3. List its needs, from those settings alone:
   - **Input**: each file or value it reads, and where it comes from.
   - **Output**: each file it writes, the yes/no value it produces, or the state it leaves (a branch, a commit).
   - **Tool**: each tool the node sets, or each one its instructions need when it sets none.
   - **Procedure**: each piece of work the instructions spell out as a series of steps, or call by a name, such as "run the tests and report the failures".
4. Name each need in kebab-case, verb first, from the instructions' own words: `run-tests`, `read-review-notes`. Give one procedure the same name wherever it appears, in any node, so `extract-shared` can match it. Never put a node id, label or file name in a procedure's name.
5. Write one entry per node to `build-report.json` `needs`.

## needs

`{ "nodeId": "<node id>", "items": [{ "name": "<kebab-case name>", "what": "<kind>: <one line>" }] }`

- `"what"` starts with its kind, `Input:`, `Output:`, `Tool:` or `Procedure:`, then one line in the instructions' words. For a procedure, that line lists its steps in order, for example `Procedure: run npm test, then list each failing test with its error`.
- Items keep the order the instructions give them.
- A node that already has a `needs` entry keeps it as it is; never add a second one.

Other auditors edit `build-report.json` at the same time. Read it right before the Edit, add one entry per Edit, and keep it valid JSON. If an Edit fails because the file changed, read it again and retry.

## Hard limits

- Never add a need the node's instructions and settings do not state. A step you think the job should have is not a need.
- Never fill a need from the target repo here: `fit-to-repo` fits the agent to the repo when it is written.
- Never raise a question from this skill. A need the instructions leave vague stays as vague as they wrote it.

## Checklist

- [ ] Every node of the piece has one `needs` entry, with its node id.
- [ ] Every item comes from the node's instructions or settings, and none is added.
- [ ] Every `"what"` starts with `Input:`, `Output:`, `Tool:` or `Procedure:`.
- [ ] A procedure that appears in another node has the same `name` there.
