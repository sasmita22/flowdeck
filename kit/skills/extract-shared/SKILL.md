---
name: extract-shared
description: How to find a procedure two or more agents of a build need alike and request one shared skill or command for it in build-report.json shared, and how to write that shared piece once code lays it down. Read in step 4 of a Flowdeck build after audit-duplicates, and before writing a KIND shared piece.
---

# Extract Shared Pieces

When several agents need the same procedure, it is written once, as a shared piece, and each agent runs it instead of restating it. You request a shared piece; code lays down its draft, and the build agents then write it and change the agents to run it.

## Request shared pieces

1. Read `build-report.json` `needs`, `merges`, and `settings.json` `permissions.allow`.
2. Group the `Procedure:` items of every node by `name`. Two items with different names whose `"what"` lists the same steps are one procedure too. Inputs, outputs and tools are never shared.
3. A procedure is shared when two or more agents need it. Count agents by piece: the nodes of one `merges` entry share a piece, so they count once, and only the first of them goes in `usedBy`.
4. Leave out of `usedBy` an agent whose file in `plugin/agents/` has a `tools:` line while `permissions.allow` lacks `Skill`: it could not run the piece. If fewer than two agents remain, request nothing for that procedure.
5. Choose the kind: a skill by default; a command only when the agents' instructions call the procedure a command a person also runs by name.
6. Name it after the procedure: its `needs` name, in kebab-case. Never the name of a piece in `manifest.json`, and never `run`.
7. Add one entry to `build-report.json` `shared`:

   `{ "name": "<kebab-case name>", "kind": "skill" | "command", "usedBy": ["<node id>", "<node id>", ...] }`

   Node ids in `manifest.json` order, each once.

## Write a shared piece

For `KIND shared`, the piece is `plugin/skills/<name>/SKILL.md` (a skill) or `plugin/commands/<name>.md` (a command). Its `## Used by` list names the agents that run it, and the `shared` entry with its name lists their node ids.

1. Read the `needs` items of those nodes that match the piece's name, and their agents' files.
2. Write one procedure: imperative, numbered steps that do what every one of those items says, and nothing they do not say. What differs per agent (its files, its report) stays in that agent.
3. Name every file the body reads or writes by a path from the repo root, the worktree the run works in. Never "the current directory": a model running the piece may take that for the piece's own folder.
4. Keep the `## Used by` list. After the scope line, the `description` says what the procedure does and when to run it (`write-skill` covers the description).
5. Delete the draft marker line.

An agent runs the piece with the `Skill` tool as `<prefix>:<name>`, a command too; `<prefix>` is the build name.

## Hard limits

- Never invent a need. A shared piece holds only a procedure the agents' instructions state, as their `needs` items record it.
- Never create, rename or delete a file: code lays down every shared piece. Never edit an agent while requesting.
- Never remove or change a `needs` entry.

## Checklist

- [ ] Every `shared` entry is a procedure two or more agents' `needs` hold, with each agent once in `usedBy`.
- [ ] No agent in `usedBy` lists tools without `Skill` while `permissions.allow` lacks it.
- [ ] Each entry is a skill unless the instructions call the procedure a command a person runs by name.
- [ ] A shared piece's steps come from its agents' `needs` items, and every file it names has a path from the repo root.
