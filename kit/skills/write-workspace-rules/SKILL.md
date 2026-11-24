---
name: write-workspace-rules
description: How to write a build container's CLAUDE.md - what the container's flow does, its own rules, and a pointer to its repo's CLAUDE.md, added on top of the standard rules, which stay byte for byte. Read before editing a container's CLAUDE.md in a Flowdeck build.
---

# Write the Workspace Rules

Each container has its own `CLAUDE.md`: `workspace/CLAUDE.md` for the workspace container, `sessions/<slug>/CLAUDE.md` for each session container. Every run session of that container reads it. Code wrote two parts: the build summary (`# Build <name>` and its `- …` lines; in the workspace's `CLAUDE.md`, also its `## Session containers` list with each container's start command; in any container's, where sessions are connected, a `## Connected sessions` list at the summary's end) and `## Standard rules`. You add the container's flow part between them.

A session works in the session's own folder, `sessions/<slug>/`, with its worktree inside it at `sessions/<slug>/<repo folder>/`. It may only read the read-only workspace folder, `workspace/`, and never edits or writes in it. A session's summary carries this as its emitted read-only note, the line `- Workspace folder (read only): …; never edit or write files in it` and the line after it.

## Steps

1. Read the container's `nodes` and `wires` in `manifest.json`, every piece in the container's folder, and, for a session container, the `CLAUDE.md` of the repo at its `REPO <path>`.
2. Below the summary, add:
   - `## What this flow does`: two or three sentences, from the container's first node to its outputs.
   - `## Flow rules`: the rules this container's flow needs beyond the standard ones, each with the node or nodes of this container it governs. Take them from the node settings: gates, hard stops, loop caps, branch variables, what may and may not be skipped.
   - `## Target repo`: for a session container, the path to the repo's `CLAUDE.md` in its worktree, `<repo folder>/CLAUDE.md` in the session's own folder, saying its rules come first. Leave this out for the workspace container, or if the repo has none.
3. As the hand-off auditor only: repeat each flow rule in the pieces of the same container that must follow it, in the words of that piece's step.

## Hard limits

- `## Standard rules` stays byte for byte as code wrote it, at the end of the file.
- Never change the summary lines: the orchestrator reads variable values from them. In a session's `CLAUDE.md` this keeps the read-only workspace note as code wrote it; in the workspace's, the `## Session containers` list and every start command stay byte for byte.
- `## Connected sessions`, where present, stays byte for byte as code wrote it, as do the SendMessage rules in the summary.
- Add no rule that has a session edit or write in the read-only workspace folder, and no rule for another container's nodes.
- Add no rule the flow or the repo does not have.

## Checklist

- [ ] What the flow does, its rules and the repo pointer are present.
- [ ] Every flow rule names the nodes it governs, and appears in each piece that must follow it.
- [ ] The summary and `## Standard rules` are unchanged; a session's read-only workspace note and the workspace's `## Session containers` list are still there.
- [ ] `## Connected sessions`, where present, and the summary's SendMessage rules are unchanged.
- [ ] No rule has a session edit or write in the workspace folder.
