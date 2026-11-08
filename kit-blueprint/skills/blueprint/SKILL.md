---
name: blueprint
description: How Flowdeck blueprints work and how to change them with the flowdeck tools - node types and settings, wires, the one-session rule, build configuration and variables, validator rules, and the ten tools. Read before answering any question about a blueprint or changing one.
---

# Blueprints

You are working beside the user's Flowdeck canvas. A blueprint is a drawing of multi-step Claude Code work: nodes joined by wires, with one session's settings. Flowdeck builds it into a Claude Code plugin and runs it turn by turn. You change it only through the `flowdeck` tools; Bash and the database are closed to you.

## How to work

1. Call `read_blueprint` before any edit, every time, so you change what is on the canvas now and not what you remember.
2. If an ask is unclear, ask the user a question instead of editing. Unclear means you would have to guess a node, a port, a setting value, a file name or which blueprint is meant. Say what you would do and the choice you need.
3. Make only the edits the ask needs. Do not tidy, rename or rewire anything else.
4. After your edits, read each answer. A refused edit changed nothing: fix the input from its `reason` or ask the user. An applied edit can still report `problems` (see Validator rules); tell the user about any you did not fix.
5. Edits land on the open canvas unsaved. The user saves them, and one Undo takes back everything from one ask.

## The one-session rule

A blueprint is one session: every node on the canvas runs inside one Claude Code session, one turn after another. The session's settings hold its `model`, its allowed tools, its permission mode, its connectors and an optional budget, plus the build configuration. Nodes do not get their own session; an Agent node runs as a subagent inside it. The tools cannot change the session's settings except its variables: for the model, allowed tools, permission mode, connectors, repository or base, tell the user to open the session settings on the canvas.

## Nodes

Every node has an `id` (Flowdeck picks it when you add one), a `label`, a position (Flowdeck places new nodes), an optional `parent`, and settings for its type. Settings you leave out when adding a node take the type's defaults.

| Type       | What it does                               | Settings (default)                                                                                                 | Ports                                                          |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `trigger`  | Where the run starts                       | none                                                                                                               | out `out` (then)                                               |
| `prompt`   | One turn of the session                    | `instructions` (""), `expectedOutput` (optional)                                                                   | in `in`, out `out` (then); in `file-in`, out `file-out` (file) |
| `agent`    | A subagent the session calls               | `role` (""), `instructions` (""), `model` ("sonnet"), `tools` ([]), `given` and `writes` (optional lists of files) | in `in`, out `out` (then); in `file-in`, out `file-out` (file) |
| `script`   | Runs a command                             | `command` (""), `args`, `successCodes`, `retryCodes` (optional; exit codes are whole numbers)                      | in `in`, out `out` (then); in `file-in`, out `file-out` (file) |
| `gate`     | Stops for the user to look before going on | `shown` (""), `skippable` (false)                                                                                  | in `in`, out `out` (then)                                      |
| `ask`      | Asks the user a question                   | `question` (""), `options` ([])                                                                                    | in `in`, out `out` (then)                                      |
| `hardstop` | A stop that cannot be skipped              | `condition` (""), `shown` (""), `locked` (true), `enabled` (true)                                                  | in `in`, out `out` (then)                                      |
| `loop`     | Repeats its body until its condition holds | `condition` (""), `cap` (3), `onCap` ("fail"; or "ask")                                                            | in `in`, out `out` (then)                                      |
| `foreach`  | Runs its body once per item of a list file | `file` ("items.txt"; relative to the session folder, no `..`)                                                      | in `in`, out `out` (then); in `file-in` (file)                 |
| `fork`     | Parallel start                             | none                                                                                                               | in `in`, out `out` (then)                                      |
| `join`     | Parallel end                               | `wait` ("all"; or "first"), `onBranchFail` ("stop"; or "wait", "skip")                                             | in `in`, out `out` (then)                                      |
| `branch`   | Takes `yes` or `no` from a yes/no variable | `variable` ("")                                                                                                    | in `in`; out `yes`, out `no` (then)                            |
| `output`   | Where the run ends, naming what it leaves  | `name` (""), `type` ("")                                                                                           | in `in` (then)                                                 |

A Loop or For each holds a body: the nodes whose `parent` is its id. Wire into and out of the body nodes themselves. A parallel section is a `fork` whose `out` wires go to two or more Agent nodes, each with one wire in and one wire out, all meeting at one `join`.

## Wires

A wire goes from an output port of one node to an input port of another, and both ports must take its kind. There are three kinds:

- `then`: run order. The `to` node runs after the `from` node.
- `file`: the `from` node leaves a file the `to` node reads. It names the `file`, a path inside the working folder (no leading `/` or `~`, no `..`, commas or control characters), and the `from` node must run before the `to` node.
- `event`: part of the schema, but no node type has an event port today, so an `event` wire is refused. Use `then` for order and `file` for data.

## Build configuration and variables

The session's build configuration holds:

- `repo`: the repository the blueprint builds from. A build is refused until it is set.
- `base`: the branch or commit builds start from.
- `buildModel`: the model the build agents use.
- `variables`: values the user fills in for each build. Each has a `name` and a kind: `text` (with an optional text `default`) or `yesno` (with an optional true/false `default`).

A Prompt or Agent uses a variable by writing `{{name}}` in its instructions. A Branch picks a `yesno` variable. Variable names use letters, digits, dashes and underscores, starting with a letter or digit, and each is declared once. `set_variable` adds a variable or changes the one with the same name; `repo`, `base` and `buildModel` are set by the user in the session settings.

## Validator rules

An edit that fits the schema is applied even if it breaks a rule below, so a blueprint can be built up step by step. Its answer lists the problems it added, each with its `rule`. `read_blueprint` lists all current problems.

- `loop-cap`: a Loop needs a whole-number `cap` of at least 1 and an `onCap` action.
- `hardstop-locked`: a hard stop stays `enabled` and `locked`. Never turn either off.
- `required-settings`: Agents and Prompts need `instructions`, Scripts a `command`, Loops a `condition`, Asks a `question`.
- `ports`: a wire leaves from an output port and arrives at an input port of its node's type, and both take its kind.
- `references`: wires and parents name nodes that are in the blueprint.
- `no-cycle`: then wires and parents do not form a cycle outside a loop.
- `loop-single-entry`: a Loop or For each body has exactly one entry.
- `node-ids`: node ids are unique and use letters, digits, dashes and underscores.
- `parallel-section`: a parallel start pairs with one parallel end around two or more single Agent branches, outside any Loop or For each.
- `loop-body`: a Loop or For each needs a Prompt or Agent in its body, cannot sit inside another, and only they hold a body.
- `body-nodes`: a Trigger or Output cannot sit inside a Loop or For each body.
- `branch-variable`: a Branch picks a `yesno` variable that is declared, and is not inside a body.
- `file-wires`: a file wire names a file inside the working folder and comes from a node that runs before the one that needs it, not beside it in a parallel section.
- `undeclared-variable`: every `{{name}}` in a Prompt or Agent is a declared variable.
- `variable-names`: variable names are unique and safe.
- `repo-required`: the blueprint names the repository it builds from.
- `agent-tools`: an Agent asks only for tools in the session's allowed tools.

## Tools

Every tool that works on a blueprint takes an optional `blueprint` (a flow id). Leave it out for the open blueprint. Naming another blueprint opens it on the canvas first, so the user sees the edit.

| Tool                | Does                                                                                            | Input                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `list_blueprints`   | Lists every saved blueprint                                                                     | none                                                                        |
| `search_blueprints` | Finds blueprints whose name or any node label contains the query                                | `query`                                                                     |
| `read_blueprint`    | Reads nodes, wires, session, whether there are unsaved changes, and current problems            | `blueprint`                                                                 |
| `add_node`          | Adds a node; the settings given are merged over the type's defaults; answers the new `nodeId`   | `type`, `label`, `parent`, `settings`                                       |
| `change_node`       | Changes a node's label or some of its settings; settings given are merged over the current ones | `nodeId`, `label`, `settings`                                               |
| `wire`              | Connects an output port to an input port                                                        | `kind`, `from` and `to` (each `{ node, port }`), and `file` for a file wire |
| `delete_node`       | Deletes a node and its wires                                                                    | `nodeId`                                                                    |
| `set_variable`      | Adds a build variable, or changes the one with the same name                                    | `name`, `kind`, `default`                                                   |
| `list_builds`       | Lists the builds made from blueprints                                                           | none                                                                        |
| `read_build`        | Reads one build                                                                                 | `id`                                                                        |

The build tools only read. There is no tool to build, run or delete; tell the user where to do that in the app.

## Example

Ask: "add a Script node that runs npm test after the planner".

1. `read_blueprint`. Find the node labelled planner and what its `out` wire leads to.
2. `add_node` with `type` `script`, `label` "npm test", `settings` `{ "command": "npm", "args": ["test"] }`.
3. `wire` a `then` wire from the planner's `out` to the new node's `in`.
4. If the planner already led somewhere, and the ask does not say where the test goes, ask the user whether the test should sit between them instead of guessing.
