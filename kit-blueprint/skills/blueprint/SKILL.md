---
name: blueprint
description: How Flowdeck blueprints work and how to change them with the flowdeck tools - node types and settings, wires and hand-offs, workspace and session containers, container and blueprint settings, variables, validator rules, and the ten tools. Read before answering any question about a blueprint or changing one.
---

# Blueprints

You are working beside the user's Flowdeck canvas. A blueprint is a drawing of multi-step Claude Code work: nodes joined by wires, grouped in containers. Flowdeck builds it into a Claude Code plugin and runs it turn by turn. You change it only through the `flowdeck` tools; Bash and the database are closed to you.

## How to work

1. Call `read_blueprint` before any edit, every time, so you change what is on the canvas now and not what you remember.
2. If an ask is unclear, ask the user a question instead of editing. Unclear means you would have to guess a node, a port, a setting value, a file name or which blueprint is meant. Say what you would do and the choice you need.
3. Make only the edits the ask needs. Do not rename or rewire anything else.
4. Load the `write-node` skill before adding a node or editing a node's settings.
5. Load the `copy-flow` skill when asked to copy, recreate or rebuild a flow from a file or a GitHub link.
6. After your edits, read each answer. A refused edit changed nothing: fix the input from its `reason` or ask the user. An applied edit can still report `problems` (see Validator rules); tell the user about any you did not fix.
7. Edits land on the open canvas unsaved. The user saves them, and one Undo takes back everything from one ask.
8. Load the `check-blueprint` skill before telling the user the blueprint is done. The ask is done only when that check passes; until then, fix what it finds or ask the user.

## Containers

Nodes sit in containers, drawn as frames on the canvas:

- The workspace container: at most one per blueprint, with a `model`.
- Session containers: any number, each one Claude Code session with a `name` no other session uses, a `repo`, a `branch` and a `model`. Its nodes run inside that session, one turn after another; an Agent node runs as a subagent inside it and can use every tool the session has.

Each container holds exactly one Start and one Stop, and its Start reaches its Stop. A blueprint with a workspace is a workflow: every node in it sits in the workspace or a session. A blueprint with no workspace is a library, and a library cannot be built. `read_blueprint` answers the `containers`, each with its `id`, `kind`, settings and member `nodes`. A Loop or For each body belongs to the container its Loop or For each sits in.

A connection joins two session containers so their sessions may message each other directly. `read_blueprint` answers the `connections`, each with the two container ids it is `between`.

The tools cannot add, delete or change a container or a connection; the user draws a connection on the canvas between two session frames. For a container's settings, the build model or the permission mode, tell the user to set them on the canvas: a container's settings by selecting its frame, the blueprint settings from the gear. Connectors are not set in the blueprint: each session uses the connectors set up for the user's Claude Code, which the Doctor page lists. To add one, the user runs `claude mcp add --scope user <name>`.

## Nodes

Every node has an `id` (Flowdeck picks it when you add one), a `label`, a position (Flowdeck places new nodes), an optional `parent` (the Loop or For each whose body holds it), and settings for its type. Settings you leave out when adding a node take the type's defaults.

| Type       | What it does                                                                                                                                                                                 | Settings (default)                                                                                                                                 | Ports                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `trigger`  | Start: where its container starts                                                                                                                                                            | none                                                                                                                                               | out `out` (then)                    |
| `agent`    | A subagent the session calls                                                                                                                                                                 | `role` (""), `instructions` (""), `model` ("sonnet"), `given` and `writes` (optional lists of files), `produces` (optional name of a yes/no value) | in `in`, out `out` (then)           |
| `gate`     | Stops for the user to look before going on                                                                                                                                                   | `shown` (""), `skippable` (false)                                                                                                                  | in `in`, out `out` (then)           |
| `ask`      | Asks the user a question                                                                                                                                                                     | `question` (""), `options` ([])                                                                                                                    | in `in`, out `out` (then)           |
| `hardstop` | A stop that cannot be skipped                                                                                                                                                                | `condition` (""), `shown` (""), `locked` (true), `enabled` (true)                                                                                  | in `in`, out `out` (then)           |
| `loop`     | Repeats its body until its condition holds                                                                                                                                                   | `condition` (""), `cap` (3), `onCap` ("fail"; or "ask")                                                                                            | in `in`, out `out` (then)           |
| `foreach`  | Runs its body once per item of a list file                                                                                                                                                   | `file` ("items.txt"; relative to the session folder, no `..`)                                                                                      | in `in`, out `out` (then)           |
| `fork`     | Parallel start                                                                                                                                                                               | none                                                                                                                                               | in `in`, out `out` (then)           |
| `join`     | Parallel end                                                                                                                                                                                 | `wait` ("all"; or "first"), `onBranchFail` ("stop"; or "wait", "skip")                                                                             | in `in`, out `out` (then)           |
| `branch`   | Takes `yes` or `no` from a yes/no variable or a value an earlier Agent produces                                                                                                              | `decidedBy` (optional: "variable" or "value"), `variable` (""), `value` (optional name an Agent `produces`)                                        | in `in`; out `yes`, out `no` (then) |
| `output`   | Stop: where its container ends, and what it hands back; its `name` and `type` come from the user, never from you: when the ask does not give them, add it with them empty, then ask for them | `name` (""), `type` ("")                                                                                                                           | in `in` (then)                      |

A Loop or For each holds a body: the nodes whose `parent` is its id. Wire into and out of the body nodes themselves. A parallel section is a `fork` whose `out` wires go to two or more Agent nodes, each with one wire in and one wire out, all meeting at one `join`.

Start and Stop are drawn as circles, Stop with a heavy ring. Each container has exactly one Start and one Stop, and its Start reaches its Stop.

## Main flow

The main flow is every node reached along `then` wires from the Start of its own container. A Loop or For each on it counts with its whole body. Every other node is ignored: it is drawn faded, its problems do not block the build, and when the user builds, Flowdeck lists the ignored nodes and leaves them out only after the user confirms. To bring a node into the build, wire it into the main flow.

## Wires

A wire goes from an output port of one node to an input port of another, and both ports must take its kind. There are two kinds:

- `then`: run order. The `to` node runs after the `from` node.
- `event`: part of the schema, but no node type has an event port today, so an `event` wire is refused. Use `then` for order.

## Hand-offs

Agents name their files in settings, not on wires: `given` lists the files an Agent reads, `writes` the files it leaves. A hand-off is one Agent's `writes` matching another Agent's `given`. A given file no Agent writes is a file already in the repo. The writer must run before the reader on every path to it, never beside it in a parallel section. A file name is a path inside the working folder (no leading `/` or `~`, no `..`, commas or control characters).

## Container settings, blueprint settings and variables

A session container's settings hold:

- `name`: the session's name, unique among the sessions.
- `repo`: the repository the session builds from.
- `branch`: the branch builds start from.
- `model`: the model the session runs on.

The workspace's settings hold its `model`. A build is refused until every one of these is set.

The blueprint's settings hold:

- `buildModel`: the model the build agents use.
- `permissionMode`: the permission mode the run session starts in.

The user sets a container's settings by selecting its frame, and the blueprint's settings from the gear.

Variables are found, never declared. A Branch decided by a variable makes the name in its `variable` a yes/no variable, and `{{name}}` in an Agent's `instructions` makes `name` a text variable. The user gives a value for each when building. A Branch is decided by a yes/no variable, or, with `decidedBy` "value", by the yes/no value named in its `value` that an earlier Agent `produces`. A Branch decided by a value reads the latest answer any earlier producing Agent recorded; Agents in between don't pass it on. Variable names use letters, digits, dashes and underscores, starting with a letter or digit, and one name is either yes/no or text, never both.

## Validator rules

A `wire` edit that breaks `ports` or `references` is refused, and so is a `change_node` or `delete_node` that names a node not in the blueprint; a refused edit changes nothing. Any other edit that fits its tool's input and the node type's settings is applied even if it breaks a rule below, so a blueprint can be built up step by step. Its answer lists the problems it added, each with its `rule`. `read_blueprint` lists all current problems.

- `loop-cap`: a Loop needs a whole-number `cap` of at least 1 and an `onCap` action.
- `hardstop-locked`: a hard stop stays `enabled` and `locked`. Never turn either off.
- `required-settings`: Agents need `instructions`, Loops a `condition`, Asks a `question`, and Stops an output `name` and `type`.
- `ports`: a wire leaves from an output port and arrives at an input port of its node's type, and both take its kind.
- `references`: wires and parents name nodes that are in the blueprint.
- `no-cycle`: then wires and parents do not form a cycle outside a loop.
- `loop-single-entry`: a Loop or For each body has exactly one entry.
- `node-ids`: node ids are unique and use letters, digits, dashes and underscores.
- `parallel-section`: a parallel start pairs with one parallel end around two or more single Agent branches, outside any Loop or For each.
- `loop-body`: a Loop or For each needs an Agent in its body, cannot sit inside another, and only they hold a body.
- `body-nodes`: a Start or Stop cannot sit inside a Loop or For each body.
- `branch-variable`: a Branch decided by a variable names it, and no Branch sits inside a body.
- `branch-value`: a Branch decided by a value reads one an Agent produces, and that Agent runs before it on every path.
- `handoffs`: a hand-off file is inside the working folder, and an Agent that writes it runs before every Agent given it, on every path and never beside it.
- `variable-kind`: a variable is either a yes/no a Branch decides on or text an Agent uses, never both.
- `variable-names`: variable names use only letters, digits, dashes and underscores.
- `workspace-count`: a blueprint has at most one workspace.
- `one-start`: each container has exactly one Start.
- `stop-required`: each container has a Stop its Start reaches.
- `one-stop`: each container has at most one Stop.
- `session-settings`: each session has a `repo`, a `branch` and a `model`, and the workspace a `model`.
- `session-names`: each session has a name no other session uses.
- `session-connections`: a connection joins two different sessions, at most once per pair.
- `outside-container`: in a workflow, every node sits in the workspace or a session.

## Tools

Only `read_blueprint` takes a `blueprint` (a flow id), to read any saved blueprint; leave it out for the open one. Reading a deleted blueprint answers that it was deleted. Edits apply only to the blueprint you were opened on, and only while it is open in the editor; an edit at any other time is refused. When asked to change another blueprint, reply that you can edit only the open one, and that the user can open that blueprint's own Agent pane.

| Tool                | Does                                                                                                 | Input                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `list_blueprints`   | Lists every saved blueprint that has not been deleted                                                | none                                  |
| `search_blueprints` | Finds blueprints whose name or any node label contains the query                                     | `query`                               |
| `read_blueprint`    | Reads nodes, wires, containers, connections, whether there are unsaved changes, and current problems | `blueprint`                           |
| `add_node`          | Adds a node; the settings given are merged over the type's defaults; answers the new `nodeId`        | `type`, `label`, `parent`, `settings` |

`add_node`'s `parent` names where the node goes: a Loop or For each id puts it in that body, and a workspace or session container id puts it in that container. In a workflow, give every node outside a body the container it belongs to, or it raises `outside-container`.
| `change_node` | Changes a node's label or some of its settings; settings given are merged over the current ones | `nodeId`, `label`, `settings` |
| `wire` | Connects an output port to an input port | `kind`, `from` and `to` (each `{ node, port }`) |
| `delete_node` | Deletes a node and its wires | `nodeId` |
| `tidy_layout` | Lays out the open blueprint; the last edit of an ask that added nodes or wires | none |
| `list_builds` | Lists the builds made from blueprints | none |
| `read_build` | Reads one build | `id` |

The build tools only read. There is no tool to build, run or delete; tell the user where to do that in the app.

## Example

Ask: "add a step that runs npm test after the planner".

1. `read_blueprint`. Find the node labelled planner, the container that lists it, and what its `out` wire leads to.
2. `add_node` with `type` `agent`, `label` "npm test", `parent` the planner's container id, `settings` `{ "role": "Test runner for the change", "instructions": "Run npm test.\nExpected output: a reply listing each failing test, or that all pass." }`.
3. `wire` a `then` wire from the planner's `out` to the new node's `in`.
4. If the planner already led somewhere, and the ask does not say where the test goes, ask the user whether the test should sit between them instead of guessing.
