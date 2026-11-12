---
name: write-handoff-template
description: How to write the template for a file one Agent hands another (its `writes` matching a later Agent's `given`), so the writing node and the reading nodes agree on its shape - fixed sections the reader can rely on. Read before writing or checking a hand-off template in plugin/templates/ of a Flowdeck build.
---

# Write a Hand-off Template

Each markdown file (`.md`) one Agent writes and another is given has one template in `plugin/templates/<file>`; any other file has none, and its writer's `Output` alone pins its shape. Before the writing node runs, the runner copies it into the worktree, and the writer replaces it with the real file. The reader relies on its sections being there. A template is a starting point, not a contract: where the node's own instructions narrow the file's form (for example "one line"), the node's own instructions win; that is fine, never a question: shape the template to that form, and the writer replaces the template's content.

A question is only for a blueprint input: an empty required field or setting, a missing hand-off or wire (a read with no writer, or a wait that can never end), or nodes that contradict each other. Everything else is decided inside the node's portion, never a question.

## Steps

1. Read the nodes on its `Written by` and `Read by` lines: their pieces and their node settings in `manifest.json`.
2. Work out what each reader takes from the file, and what the writer says it writes.
3. Fill the template:
   - `## Purpose`: one or two lines on what the file carries, from which node to which.
   - `## Content`: the fixed sections, in order. One heading or field per thing a reader uses, each with one line saying what goes there. For a data file (JSON, YAML), show the shape as a fenced example instead.
   - `## Open questions`: keep the heading; the writer lists there what it could not settle.
4. If a reader needs content the writer's node never produces, shape the template for the reader and add to `questions` in `build-report.json` `{ "nodeId": "<reader>", "otherNodeId": "<writer>", "text": "<what the reader needs that the writer never produces>" }`.

## Hard limits

- Keep the first line, the `@template` marker, as it is: the run's writer replaces it, and the build check ignores it.
- Keep the `Written by` and `Read by` lines as they are.
- Never add a section no reader uses.

## Checklist

- [ ] Every section a reader uses is there, in a fixed order, with one line on what goes in it.
- [ ] The writer's `Output` and the template agree, or a question says where they do not.
- [ ] The `@template`, `Written by` and `Read by` lines are unchanged.
