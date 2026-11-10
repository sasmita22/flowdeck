---
name: copy-flow
description: How to copy an existing flow described in a local file onto the open blueprint faithfully - one node per step, the same order and the same wires, no step added or dropped. Read when the user asks to copy, recreate or rebuild a flow from a file.
---

# Copy a flow

The user has a flow written down somewhere else, for example a workflow file or a list of steps, and wants it on the canvas. A copy is faithful: the blueprint does what the source does, step for step, and nothing more.

## Read the source

1. Read the file with the `Read` tool, at the path the user gives. If no path is given, ask for it.
2. You can read only files on this machine. When the user gives a web address instead of a path, say so and ask them to save the page as a local file and give its path.
3. List the source's steps in order. For each one note what it does, the files it reads and the files it leaves.

## Copy it

1. Call `read_blueprint`, as for any edit.
2. Add one node per source step, in the source's order. Choose each type and fill each node by the `write-node` skill, keeping the source's own words for its instructions. Use the source's step name as the label.
3. Add the same wires: a `then` wire from each step to the next in the source's order, and a `file` wire for each file one step hands another, named as the source names it.
4. Start and Stop are not steps. Use the blueprint's own Start and Stop, adding one only where the blueprint has none; wire Start to the first step and the last step to Stop.
5. No step is added or dropped. A check, a retry or a gate the source does not have stays out, and every step the source has goes in, even one that looks redundant.

## When the source is unclear

If you would have to guess a step's type, its order, or which file goes where, ask the user a question instead of editing. Say what you would do and the choice you need.

## Done

The copy is done when the blueprint has one node per source step in the same order, with the same wires, and the `check-blueprint` skill passes.
