---
name: fit-to-repo
description: How to make a general ask fit the target repo - "review code" means the repo's own rules, gates and test types read from its CLAUDE.md and build files, not a generic checklist. Read with the kind skill before writing any piece of a Flowdeck build.
---

# Fit to the Repo

A node says what to do in general. The piece must say how this repo does it. The repo's own files are the only source; this kit holds no rules of its own.

A question is only for a blueprint input: an empty required field or setting, a missing wire (a read with no writer, or a wait that can never end), or nodes that contradict each other. Everything else is decided inside the node's portion, never a question.

## Steps

1. Find the target repo at the absolute path on your prompt's `REPO <path>` line (also `Target repo` in `CLAUDE.md`). Work only from its files, with Read, Grep and Glob.
2. Read its `CLAUDE.md` (root first, then any nested one on the piece's path) and every guide it names that the piece's job touches.
3. Read the build files that set its commands: the package manifest, build scripts, task runner and CI config it has.
4. For each part of the piece that names a rule, a gate, a command or a test type, use the repo's own. Quote commands exactly as the repo writes them. Fit how the node's own job is done in this repo; never add a step, gate or obligation the node's own steps do not call for.
5. A node that reviews or checks work judges it against the repo's gates: for each gate the repo's `CLAUDE.md` sets, the piece names it and must quote that gate's command exactly as the repo writes it, as the bar the review checks against, not a step the piece runs.
6. After each rule you add, name the repo file it came from, for example: "Run `npm run check` (from `CLAUDE.md`)."
7. Where the repo's rules are long, point to the file and quote only the lines the piece acts on.

## Hard limits

- Never add a rule the repo does not have. No generic checklist, no rule from memory or from another repo.
- When the repo is silent on something the node needs, keep the node's own wording; never a question.
- The target repo is read only.
- Run-time facts are never build-time questions: the branch, the diff, git state, script output and which files will exist are settled when the flow runs, so write the piece to handle them then.

## Checklist

- [ ] Every repo-specific rule, gate or command names the repo file it came from.
- [ ] Every command is quoted exactly as the repo writes it.
- [ ] A review or check piece names each repo gate with its command quoted.
- [ ] Nothing was added that the repo lacks.
