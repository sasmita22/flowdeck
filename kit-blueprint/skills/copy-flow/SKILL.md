---
name: copy-flow
description: How to copy an existing flow described in a local file or GitHub link onto the open blueprint faithfully - one node per step, the same order and the same wires, no step added or dropped. Read when the user asks to copy, recreate or rebuild a flow from a file or GitHub link.
---

# Copy a flow

The user has a flow written down somewhere else, for example a workflow file or a list of steps, and wants it on the canvas. A copy is faithful: the blueprint does what the source does, step for step, and nothing more.

## Read the source

1. If the user gives neither a path nor a link, ask for it.
2. Read the source by where it is:
   - A file or a cloned repo on this machine: read it with the `Read` tool, and find files in it with `Glob` and `Grep`.
   - A GitHub link, on github.com or raw.githubusercontent.com: use the GitHub tools (`mcp__github__get_file_contents` and the rest) when you have them, because they return the file exactly and are the only way into a private repo. Otherwise fetch the link, preferring the raw file.
   - A GitHub link that cannot be read while you have no GitHub tools: the repo may be private. Tell the user to run `gh auth login` and reopen the pane.
   - Any other web address: say that only github.com and raw.githubusercontent.com links or files on this machine can be read.
3. List the source's steps in order. For each one note what it does, the files it reads and the files it leaves.

## Copy it

1. Call `read_blueprint`, as for any edit.
2. Add one node per source step, in the source's order. Make every work step an `agent`, including one that runs a command; a step where the user looks, answers or must stop takes its type from the `write-node` skill. Fill each node by that skill, keeping the source's own words for its instructions. Use the source's step name as the label.
3. Add the same wires: a `then` wire from each step to the next in the source's order, and a `file` wire for each file one step hands another, named as the source names it.
4. Start and Stop are not steps. Use the blueprint's own Start and Stop, adding one only where the blueprint has none; wire Start to the first step and the last step to Stop.
5. No step is added or dropped. A check, a retry or a gate the source does not have stays out, and every step the source has goes in, even one that looks redundant.

## When the source is unclear

If you would have to guess a step's type, its order, or which file goes where, ask the user a question instead of editing. Say what you would do and the choice you need.

## Done

The copy is done when the blueprint has one node per source step in the same order, with the same wires, and the `check-blueprint` skill passes.
