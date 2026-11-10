---
name: audit-orchestrator
description: How to check a build's orchestrator skill, plugin/skills/run/SKILL.md, holds up in plain Claude Code where no runner enforces anything - its Prompt, Agent and Fork steps only hand off, it waits for each result, and states every gate, hard stop and loop cap as a hard rule. Read in step 4 of a Flowdeck build, before editing the orchestrator skill.
---

# Audit the Orchestrator

Code writes `plugin/skills/run/SKILL.md` from `manifest.json`, run as `/<build-name>:run`. Outside Flowdeck nothing enforces the flow but this file, so its wording must hold. You may improve the wording. The order never changes.

A question is only for a blueprint input: an empty required field or setting, a missing wire (a read with no writer, or a wait that can never end), or nodes that contradict each other. Everything else is decided inside the node's portion, never a question.

## Checks

1. **Prompt, Agent and Fork steps only hand off.** A Prompt step reads its step skill by path; an Agent step dispatches its agent, and a Fork step its branch agents, by full name `<build-name>:<piece>`. None of them does that work itself. The other steps (Start, Gate, Ask, Script, Loop, For each, Branch, Join, Hard stop, Stop) are the orchestrator's own: it asks, runs, repeats, picks or stops as the line says.
2. **Right inputs, then wait.** Each dispatch carries that node's prompt as code wrote it (`NODE <nodeId>` and its files), and the step says to wait for the result before going on.
3. **Hard rules.** Every Gate, Ask, Hard stop and Loop cap reads as a rule that cannot be skipped: what to ask or check, and what to do at the cap or the stop. A flow with none of these nodes gets no such rule.
4. **Backed by hooks.** Where a guard hook in `plugin/hooks/` already enforces a rule (no force pushes; rules re-sent after compaction), the wording agrees with it.

## Hard limits

- Keep every step line starting `<n>. NODE <nodeId> `, in the same order, one per node. Never add, remove, merge or move a step.
- Never change a branch target, a loop cap, a gate's question, a Script command, or a dispatch prompt.
- Keep the frontmatter and the scope line. Never touch `plugin/hooks/`.
- A rule the blueprint's nodes do not state is never added and never a question.

## Checklist

- [ ] Every Prompt, Agent and Fork step hands off and waits; none does that work itself.
- [ ] Every gate, hard stop and loop cap is stated as a hard rule.
- [ ] The `NODE` lines are in the same order, with the same targets and caps, as before your edit.
