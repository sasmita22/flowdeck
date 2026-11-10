---
name: audit-duplicates
description: How to find build pieces that do the same job, even when worded differently, and ask code to merge them into one reusable piece - while look-alikes that do different jobs stay apart with the reason. Read in step 4 of a Flowdeck build, before writing merges or keptApart to build-report.json.
---

# Audit Duplicates

Two nodes that do one job should share one piece, called by each with its own files. Example: "review the Android diff" and "check code quality before the PR" are worded differently but do the same job. Code applies a merge; you only request it.

A question is only for a blueprint input: an empty required field or setting, a missing wire (a read with no writer, or a wait that can never end), or nodes that contradict each other. Everything else is decided inside the node's portion, never a question.

## Steps

1. List the Agent nodes in `manifest.json`. Compare agents with agents only; never templates, shared pieces or the workspace rules.
2. For each pair, compare what the pieces do: role, steps, inputs and outputs. Ignore wording, labels and names.
3. Same job, differing only in their files, settings or values: they merge. Each node keeps passing its own details through its prompt, so the merged piece must be general enough to serve both. Differences in output layout or wording never block a merge and are never a question: they become each node's own details (its given and written files, and a per-node layout line in the merged piece).
4. Look alike (same or similar label, similar wording) but a different job: they stay apart.
5. Write the results to `build-report.json`:
   - `merges`: `{ "nodeIds": ["<id>", "<id>"], "reason": "<the one job they share>" }`, node ids in `manifest.json` order.
   - `keptApart`: `{ "nodeIds": ["<id>", "<id>"], "reason": "<how their jobs differ>" }`.

## Hard limits

- Never edit pieces to merge them, and never delete one. Code makes the shared piece, named after the first node, and has it audited again.
- A node appears in at most one merge. A group of three that share a job is one merge of three.
- Unsure whether two jobs are the same: keep them apart, never a question.

## Checklist

- [ ] Every pair was compared on role, steps, inputs and outputs, not wording.
- [ ] Each merge joins agent nodes only, each node in one merge only, with the shared job as the reason.
- [ ] Every look-alike pair left apart is in `keptApart` with the difference as the reason.
