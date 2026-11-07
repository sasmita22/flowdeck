---
name: write-workspace-rules
description: How to write a build workspace's CLAUDE.md - what the flow does, the flow's own rules, and a pointer to the target repo's CLAUDE.md, added on top of the standard rules, which stay byte for byte. Read before editing CLAUDE.md in a Flowdeck build.
---

# Write the Workspace Rules

Every run session in the workspace reads `CLAUDE.md`. Code wrote two parts: the build summary (`# Build <name>` and its `- …` lines) and `## Standard rules`. You add the flow's own part between them.

## Steps

1. Read `manifest.json`, every piece, and the target repo's `CLAUDE.md` in the repository folder the summary names.
2. Below the summary, add:
   - `## What this flow does`: two or three sentences, from the first node to the outputs.
   - `## Flow rules`: the rules this flow needs beyond the standard ones, each with the node or nodes it governs. Take them from the node settings: gates, hard stops, loop caps, branch variables, what may and may not be skipped.
   - `## Target repo`: the path to the repo's `CLAUDE.md`, saying its rules come first. Leave this out if the repo has none.
3. As the hand-off auditor only: repeat each flow rule in the pieces that must follow it, in the words of that piece's step.

## Hard limits

- `## Standard rules` stays byte for byte as code wrote it, at the end of the file.
- Never change the summary lines: the orchestrator reads variable values from them.
- Add no rule the flow or the repo does not have.

## Checklist

- [ ] What the flow does, its rules and the repo pointer are present.
- [ ] Every flow rule names the nodes it governs, and appears in each piece that must follow it.
- [ ] The summary and `## Standard rules` are unchanged.
