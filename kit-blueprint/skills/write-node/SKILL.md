---
name: write-node
description: How to write one blueprint node well - choosing its type, an Agent's role, instructions and expected output, what a Prompt builds on, and when a File wire carries its work. Read before adding a node or editing a node's settings.
---

# Write a node

A node is one step of the user's work. Write it so the build agents can turn it into a skill or an agent without guessing. The `blueprint` skill holds the node types, their settings and ports; this skill says how to fill them.

## Choose the type

Pick the type whose "What it does" cell in the `blueprint` skill's Nodes table matches what the step does. Where two seem to fit:

- A turn of the session itself, which sees everything earlier turns did, is a `prompt`. Work handed to a subagent with its own role, model and tools, which sees only the files it is given, is an `agent`.
- Running a command is a `script`, not an `agent` told to run it.
- The user looking before the work goes on is a `gate`; the user choosing an answer is an `ask`; a stop that must never be skipped is a `hardstop`.

If what the user said fits more than one type, ask which they mean instead of picking.

## Agent node

| Part            | Where it goes                                                | What it says                                                                            |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Role            | `role`                                                       | Who the subagent is, in one line, for example "Reviewer of the change against the plan" |
| Instructions    | `instructions`                                               | What to do, as steps in order, then what to hand back                                   |
| Expected output | The last line of `instructions`, starting `Expected output:` | The file it writes and what that file holds, or the reply it ends with                  |
| Files           | `given` and `writes`, or File wires (see below)              | The files it reads and the files it leaves                                              |
| Tools           | `tools`                                                      | Only tools in the session's allowed tools (`agent-tools`)                               |

The Agent settings have no expected output field, which is why it is a line in `instructions`. Leave `model` at its default unless the user names one.

## Prompt node

- `instructions`: what the turn does, as steps in order.
- `expectedOutput`: what the turn leaves for the next node.
- A Prompt node that is not the first step on the main flow says in its `instructions` what it builds on: the earlier node by its label, or the file it reads through a File wire.

## File wires

Use a `file` wire when a later node needs something an earlier node writes as a file: from the writer's `file-out` to the reader's `file-in`. Prompt, Agent and Script nodes have both ports; For each has only `file-in`, for its list file.

An Agent sees only the files it is given, so when an Agent works on what an earlier node produces, that node writes it to a file and a `file` wire carries it to the Agent. A `file` wire carries data, not order: keep the `then` wire between the two nodes as well.

Name the file for what it holds, with the extension of its format, for example `plan.md` or `review-notes.md`. A `.md` file gets a hand-off template in the build. The writer's instructions and the reader's instructions use the same name.

## Write only what was asked

Put in each node what the user asked for that step, in their words where they gave them. Add no check, retry, limit, tool or extra node the user did not ask for. Use `{{name}}` only for a variable the blueprint declares.

## Done

The node is written when its type fits the step and every part above that applies to its type is filled.
