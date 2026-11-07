---
name: write-step
description: How to write a Prompt node's step skill - one turn of the run's own session that says what earlier work it builds on and ends with the output a later node reads. Read with write-skill before writing or checking any step skill in a Flowdeck build.
---

# Write a Step

A step skill is one turn of the run's main session, not a subagent. The runner calls it as `/<build-name>:<piece> NODE <nodeId>`; the orchestrator reads it by path. `write-skill` covers the description and frontmatter; this skill covers the body.

## Body

Keep the parts code laid down: the instructions, `Expected output:` when the node set one, `## Builds on` and `## Leaves behind`.

1. Instructions: rewrite the node's instructions as imperative steps. Keep every fact the node gave; add only what `fit-to-repo` finds in the target repo.
2. `## Builds on`: the earlier work it reads, each as a file path and the node that wrote it (from the File wires and the earlier steps in `manifest.json`). `None.` only when it truly starts from nothing.
3. `## Leaves behind`: the exact output a later node reads, as a path and its pinned shape. Start from the file's template in `plugin/templates/` when one exists; where the node's own instructions narrow the file's form, the node's own instructions win. In a merged piece where the nodes' output layouts differ, add one line per node, `NODE <id>: <layout>`, so each node keeps its own layout. When the output is only the session's state (a branch, a commit), say what state.

## Checklist

- [ ] It says what earlier work it builds on, with the node that wrote each file.
- [ ] It ends with the expected output a later node reads, in a shape that node can rely on.
- [ ] Every instruction from the node is still there.
- [ ] `write-skill`'s checklist passes.
