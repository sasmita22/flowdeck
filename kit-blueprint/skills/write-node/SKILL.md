---
name: write-node
description: How to write one blueprint node well - choosing its type, an Agent's role, instructions and expected output, what it builds on, the files it hands on, and the yes/no variables it produces. Read before adding a node or editing a node's settings.
---

# Write a node

A node is one step of the user's work. Write it so the build agents can turn it into a skill or an agent without guessing. The `blueprint` skill holds the node types, their settings and ports; this skill says how to fill them.

## Choose the type

Every work step is an `agent`: a subagent with its own role and model, which knows only what its instructions tell it. That holds for a step that runs a command too: the Agent's instructions say which command to run and what to report. The other types are not work:

- The user looking before the work goes on, or the run stopping when something holds, is a `gate`.
- Repeating, parallel work and picking a path are `loop`, `fork` and `join`, and `branch`, around Agents.

If what the user said fits more than one type, ask which they mean instead of picking.

## Agent node

| Part            | Where it goes                                                | What it says                                                                            |
| --------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Role            | `role`                                                       | Who the subagent is, in one line, for example "Reviewer of the change against the plan" |
| Instructions    | `instructions`                                               | What to do, as steps in order, then what to hand back                                   |
| Expected output | The last line of `instructions`, starting `Expected output:` | The file it writes and what that file holds, or the reply it ends with                  |
| Produces        | `produces` (rows, see below)                                 | Each yes/no variable it sets at the end of its turn, for a later Branch to decide on    |

The Agent settings have no expected output field, which is why it is a line in `instructions`. Leave `model` at its default unless the user names one.

A good Agent does one job, with its steps in the user's words. An Agent that is not the first step on the main flow says in its `instructions` what it builds on: the file it reads, named as the earlier node names it. Its instructions also name every file it leaves for a later node.

## Gate node

| Part              | Where it goes | What it says                                                                                                          |
| ----------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Condition to stop | `stopWhen`    | "always" when the user wants to look every time; "conditional" when they want the run to stop only if something holds |
| Condition         | `condition`   | For "conditional" only: what must hold for the run to stop, in the user's words                                       |
| Instruction       | `instruction` | What the user sees when it pauses and what they decide                                                                |

An "always" Gate is skipped in automatic runs and auto mode; a "conditional" Gate is checked in every run. Text the user types on Continue reaches the Agents after it. A Gate never produces a value.

## Hand-offs

When an Agent works on what an earlier Agent leaves, the earlier one's instructions say which file it writes and the later one's instructions name the same file. That match is the hand-off. A file no Agent writes is a file already in the repo. The writer must run before the reader on every path, never beside it in a parallel section; `then` wires set that order.

Name the file for what it holds, with the extension of its format, for example `plan.md` or `review-notes.md`. The writer's instructions and the reader's instructions use the same name.

## Produced variables

When a later step picks a path from a yes or no the work decides, the Agent that decides it gets one `produces` row per variable: `{ "variable", "yesIf", "noIf" }`. `variable` is a Branch variable the blueprint owns, `yesIf` says when it is yes and `noIf` when it is no, in the user's words. An Agent with no such decision has `produces` `[]`. The Branch reads the value the latest producing Agent before it set.

## Write only what was asked

Put in each node what the user asked for that step, in their words where they gave them. Add no check, retry, limit, tool or extra node the user did not ask for. Use `{{name}}` only for a value the user gives when building.

## Done

The node is written when its type fits the step and every part above that applies to its type is filled.
