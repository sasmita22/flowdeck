---
name: write-skill
description: How to write a build's skill so the right agent picks it up and follows it - the scope line, a description that says what and when, one concern, a body short enough to read in full. Read before writing or checking any skill in a Flowdeck build.
---

# Write a Skill

A build skill is called by its full name, `<build-name>:<piece>`, or read by path by the build's orchestrator. Its description decides whether it is picked; its body is all the reader gets.

## Description

1. It starts with the scope line code wrote, with this build's names filled in:

   `Part of build <build> (repo <repo>, workspace <workspace>). For work in this build's workspace, use this, not a similarly named skill from elsewhere.`

   Keep it word for word as the first text of `description`. Never move, reword or drop it.

2. After it, say what the skill does and when to use it, in the words a person would type to ask for that work. At least 60 characters, and never the node label alone.
3. Keep the value on one line in double quotes, with any `"` inside written as `\"`.

## Body

- One concern. If the node mixes two jobs, write it as drawn and add it to `mixedJobs` in `build-report.json` as `{ "nodeId": "<node id>", "note": "<the two jobs>" }`. Never split it.
- Imperative steps, in order. Each step says what to read and what to produce.
- Short enough to read in full. You cannot add files, so detail that belongs to another piece stays in that piece; name it instead of repeating it.
- Name another piece only by its full name `<build-name>:<piece>`, and only a piece of this build (a `piece` in `manifest.json`).
- Whether it may run on its own is code's call: keep the frontmatter as code wrote it. Step skills carry `disable-model-invocation: true` so only the runner and the orchestrator call them.

## Checklist

- [ ] Check the scope line: `description` starts with it, unchanged from the draft.
- [ ] The text after it says what and when, is at least 60 characters, and is not the node label.
- [ ] `name` and every other frontmatter field are as code wrote them.
- [ ] One concern; a mixed job is flagged, not split.
- [ ] The draft marker line is gone and the body says more than the draft.
- [ ] Every `<build-name>:<piece>` names a piece of this build.
