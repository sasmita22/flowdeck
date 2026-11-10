---
name: write-agent
description: How to write a build's subagent that another step can hand work to - the scope line, a description that says what and when to dispatch it, role, inputs, steps, a pinned output shape and when to stop, with the fewest tools. Read before writing or checking any agent in a Flowdeck build.
---

# Write an Agent

A build agent is dispatched by its full name, `<prefix>:<piece>`, where `<prefix>` is the build name. Its file is all it knows. The prompt it gets starts with `NODE <nodeId>`, may list `You are given: <files>` and `Write: <files>` for that node, and ends with `Go` (or `Go.` and one item inside a For each). A merged agent serves several nodes, each passing its own files this way.

Write the agent from its node's `needs` entry in `build-report.json`, which `analyze-job` wrote: every `Input:` item goes in Inputs, every `Output:` item in Output, every `Tool:` item is one the agent can use (see Frontmatter), and every `Procedure:` item in Steps.

A question is only for a blueprint input: an empty required field or setting, a missing wire (a read with no writer, or a wait that can never end), or nodes that contradict each other. Everything else is decided inside the node's portion, never a question.

## Description

1. It starts with the scope line code wrote, with this build's names filled in:

   `Part of build <build> (repo <repo>, workspace <workspace>). For work in this build's workspace, use this, not a similarly named skill from elsewhere.`

   Keep it word for word as the first text of `description`. Never move, reword or drop it.

2. After it, say what the agent does and when to dispatch it: "Use after …, when …". At least 60 characters, and never the node label alone.
3. Keep the value on one line in double quotes, with any `"` inside written as `\"`.

## Body

Keep the five sections code laid down, in this order:

- `## Role`: one job, in one or two sentences. A node that mixes two jobs is written as drawn and added to `mixedJobs` in `build-report.json` as `{ "nodeId": "<node id>", "note": "<the two jobs>" }`; never split it.
- `## Inputs`: every file it reads and who writes it. Files that differ per node come from the prompt's `You are given:` line; say so instead of hard-coding them in a merged agent.
- `## Steps`: imperative and numbered, built from the node's instructions. Each step reads or produces something named.
- `## Output`: the files it writes (the prompt's `Write:` line) and their pinned shape: headings or fields, in order, that the next node reads as is. Start from the file's template in `plugin/templates/` when one exists; where the node's own instructions narrow the file's form, the node's own instructions win. In a merged piece where the nodes' output layouts differ, add one line per node, `NODE <id>: <layout>`, so each node keeps its own layout.
- `## When to stop`: the node's done condition; a stuck path or a retry cap only where the node's own text states one.

## Shared pieces

Each `SHARED <prefix>:<name>` line in your prompt, and each `build-report.json` `shared` entry whose `usedBy` holds the agent's node, names a shared piece that does one of its procedures. Replace that procedure's steps with one step: run `<prefix>:<name>` with the `Skill` tool, then use what it leaves. Keep the steps that differ for this agent. Never restate the shared piece's steps.

## Frontmatter

- `tools`: keep what the node set. If the node set none and the steps need fewer than every tool, list the fewest that do the job, each one in `settings.json` `permissions.allow`. A tool the steps need that the allow list lacks is never a question: write the piece with the allowed tools.
- An agent that runs a shared piece and has a `tools:` line lists `Skill` in it.
- `model`: keep what the node set; never add one.
- Never change `name`.

## Checklist

- [ ] Check the scope line: `description` starts with it, unchanged from the draft.
- [ ] The text after it says what the agent does and when to dispatch it, is at least 60 characters, and is not the node label.
- [ ] Role, Inputs, Steps, Output and When to stop are all filled; Output pins a shape.
- [ ] Every tool is in `settings.json` `permissions.allow`.
- [ ] The draft marker line is gone and the body says more than the draft.
- [ ] Every `needs` item of the node is in Inputs, Output, `tools` or Steps.
- [ ] Every shared piece the agent uses is run with the `Skill` tool as `<prefix>:<name>`, and `Skill` is in its `tools:` line when it has one.
- [ ] Every `<prefix>:<piece>` names a piece of this build or a shared piece in `shared`.
