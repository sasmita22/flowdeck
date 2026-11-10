---
name: audit-handoffs
description: How to check that a build's agents and steps work together across the whole flow - every file read has an earlier writer, shapes match, every loop has a cap, nothing waits forever. Read in step 4 of a Flowdeck build, before writing questions to build-report.json.
---

# Audit the Hand-offs

Follow the flow in `manifest.json` order, along its wires, and check each hand-off from the reader's side. Fix wording; anything only the blueprint can fix becomes a question.

A question is only for a blueprint input: an empty required field or setting, a missing wire (a read with no writer, or a wait that can never end), or nodes that contradict each other. Everything else is decided inside the node's portion, never a question.

## Checks

1. **Every read has a writer.** For each file a piece reads (its node's `given` settings, its incoming File wires, and the files its text says it reads), find the node that writes it earlier in the flow. A file that already exists in the target repo needs no writer (check with Glob).
2. **Shapes match.** The writer's `Output` and the file's template, when it has one, give the sections the reader's `Inputs` and steps use, with the same names. A template is a starting point, not a contract: where the node's own instructions narrow the file's form (for example "one line"), the node's own instructions win; that is fine, never a question, and the writer replaces the template's content.
3. **Every loop has a cap.** A Loop node has its cap in `manifest.json`. A retry cap or a stop-and-report applies only to a retry the node's own text states, as that text states it; never add one.
4. **Nothing waits forever.** No step waits on a file, an answer or a branch that never comes on some path: a Join waiting on a branch that may be skipped, a reader that runs before its writer on one Branch path.
5. **No two pieces claim the same job.** Leave the call to `audit-duplicates`; note the pair for it.

## What to do with a finding

- A wording mismatch (a section named differently, a retry cap the node's own text states but its piece drops): Edit the reader's or the writer's piece so they agree. Keep each node's facts.
- A read with no writer: add to `questions` in `build-report.json` `{ "nodeId": "<reader>", "otherNodeId": "<upstream node expected to write it>", "text": "<file> is read by <reader> but no earlier node writes it." }`. When no upstream node fits, leave out `otherNodeId` and say so in `text`.
- Any other gap the user must close (a missing wire, a wait that can never end): add to `questions`, naming the node that stalls and, as `otherNodeId`, the node it waits on.
- A file or reply that no later node reads: leave it as drawn, never a question. The person running the flow reads every node's reply.

## Checklist

- [ ] Every file read by every piece has an earlier writer, exists in the worktree, or is a question.
- [ ] Every writer's shape matches its readers'.
- [ ] Every Loop node has its cap; a retry has one only where the node's own text states it.
- [ ] No path through the flow waits on something that never comes.
