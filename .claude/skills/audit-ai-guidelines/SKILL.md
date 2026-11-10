---
name: audit-ai-guidelines
description: Audits every piece of model-facing text in Flowdeck (skills, agents, prompts, tool descriptions, refusal reasons) against one standard and records the findings in docs/ai-guidelines-audit.md. Run it after any ticket that adds or changes a skill, an agent or model-facing text.
---

# Audit AI guidelines

Model-facing text is any text a Claude session reads: a skill, an agent, a prompt typed into a
session, a file written into a build, an MCP tool description, a deny or refusal reason, a tool
result or a validator rule message. This skill is the single home of the standard that text
follows and of the procedure that checks it. Run the sections in order. The findings go into
`docs/ai-guidelines-audit.md`.

## Standard

Every skill, agent and prompt meets all seven rules.

1. **One concern per skill.** A skill or agent does one job. Two jobs are two skills.
2. **The description says what and when.** It states what the text does and when to use it, in
   at least 60 characters, with the word "when", "before" or "after".
3. **The body is short enough to read in full.** At most 200 lines after the frontmatter.
4. **Output shapes are pinned.** Anything a model writes that code parses (a line grammar, a JSON
   file, a fenced verdict) is spelled out exactly, field by field.
5. **Stop conditions are explicit.** The text says when the work is done and what to do when it
   cannot be done.
6. **No rule beyond what the blueprint asks.** A rule the blueprint's nodes do not state is never
   added by the text.
7. **Wording is consistent across skills.** One thing has one name everywhere; a phrase another
   file pins is quoted exactly.

## Inventory

The inventory lives in `docs/ai-guidelines-audit.md` under `## Inventory`, one row per touchpoint
with: id, file and symbol, what the model reads, read by, the guideline it follows today, and the
standard result. Files the detection rule matches that hold no model-facing text go under
`## Not model-facing`, each with a one-line reason.

Detection rule. A file under `src/`, `bin/`, `kit/` or `kit-blueprint/` must be listed in exactly
one of those two tables when any of these holds:

- it is a `.md` file under `kit/` or `kit-blueprint/`;
- it is a `.ts` file under `src/core/compiler/` (including `rules/`), or matches
  `src/core/nodes/*/compile.ts` or `src/core/nodes/*/execute.ts`;
- it is a `.ts` file under `bin/`;
- it is a `.ts` file directly in `src/core/run/`, `src/core/flow/`, `src/adapters/hook-socket/` or
  `src/app/renderer/assistant/`;
- its text contains `sendPrompt(`;
- its text matches `/export\s+(?:const|function)\s+\w*(?:Turn|TurnText|Request)\b/`;
- its text contains `refuse(`.

Paths are read from the `File / symbol` cell (the second) of each `## Inventory` row and the
`File` cell (the first) of each `## Not model-facing` row, as backticked repo-relative paths ending
`.ts` or `.md`. `test/kit/ai-guidelines-inventory.test.ts` enforces the
rule: every matched file listed once, every listed path real.

Beyond the rule, search by concept so nothing that does not look like a prompt is missed:

- text passed to `sendPrompt`;
- files written into builds (`CLAUDE.md`, skills, agents, hand-off templates, hooks);
- MCP tool descriptions and the `.describe()` texts of their input schemas;
- deny and refusal reasons;
- tool results and validator rule messages;
- kit skills and agents.

A touchpoint that is planned but has no code yet gets a row with id `P<NN>` and no file.

## Standard pass

For every inventory row that is a skill, an agent or a prompt, record pass or fail for each of
the seven rules, with a one-line reason. Mark which failures are mechanical (name, description,
length, a ticket id) and which need a rewording judgement.

## Staleness check

Read every skill, agent and prompt claim by claim against the checked-out code: node types,
ports, defaults, tool names, rule ids, build-check rule ids, skill names, report fields, file
names and commands. Record each stale claim as `file › claim › said X, true is Y`.

## Gaps

List what a model needs to do its job well and no text gives it. Name the touchpoint each gap
affects.

## Choosing the fix

| Finding                                             | Fix                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| A stale claim about a fact code defines             | A test in `test/kit/` that compares the text with the code, then the text |
| A stale claim with no code source                   | Reword; record "said X, true is Y"                                        |
| A failed standard rule fixable by rewording         | Reword the file                                                           |
| A fix that needs more than rewording                | Stop and raise it; record it in the report as open                        |
| A gap the audit shows that no existing skill covers | A new skill, one concern, in the kit that uses it                         |
| A gap an existing skill should cover                | Reword that skill                                                         |

A new build skill in `kit/skills/` is also added to the skill-name list of the `kit/agents/*.md`
agent that uses it, because the build session denies the Skill tool and the agents read skills by
path. Every test that pins the number or names of skills is updated with it.

## What a fix may change

Rewording only. These stay as they are:

- the build-turn line grammar (`PIECE`, `KIND`, `REPO`, `FAILED`, `QUESTION`, `ANSWER` blocks);
- the `build-report.json` fields;
- the verdict reply, a final json fence holding `{"done": bool}`;
- the build-check strings: the scope line, the standard rules text and version, the hand-off
  folder line, orchestrator lines, the `@unfilled` marker, `<prefix>:<piece>` references;
- the sentence `Then reply DONE.` and the code that replaces it;
- the build agent names;
- the blueprint session's denied tools; no skill tells the pane to fetch;
- every phrase a test pins, unless its pin changes with its intent kept and the reason recorded.

## Evals

- Run each consistency eval 3 times.
- Compare structure only, never wording: node types, their order and wires for blueprints;
  pieces and merges for builds.
- Use haiku and the shortest prompt that proves the point.
- Make each eval fail once on purpose, record the failure, revert, then run it green.

## Report shape

`docs/ai-guidelines-audit.md` holds these sections, in this order:

1. `## Inventory`
2. `## Not model-facing`
3. `## Standard`
4. `## Standard results`
5. `## Stale claims`
6. `## Gaps`
7. `## Skills added or changed and why`
8. `## Evals`

The audit is done when every section is filled and the inventory test passes.
