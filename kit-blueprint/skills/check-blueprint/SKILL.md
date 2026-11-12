---
name: check-blueprint
description: The quality check on a blueprint after editing it - read it back, check every node and wire, and say done only when all pass. Read before telling the user the blueprint is done.
---

# Check the blueprint

Run this check once the ask's other edits are made and before you tell the user the work is done.

## Check

1. If the ask added nodes or wires, call `tidy_layout` as the ask's last edit.
2. Call `read_blueprint` and check what is on the canvas now, not what you meant to write.
3. Every node you added or changed meets the `write-node` skill: its type fits the step, and every part that applies to its type is filled.
4. When you copied a flow, compare with the source by the `copy-flow` skill: the same number of steps, in the same order, of the matching types, with the same wires. No step added or dropped.
5. `read_blueprint` lists no current `problems` (see the `blueprint` skill's Validator rules) that this ask's edits added, and none left that your tools can fix. A problem whose fix is in the session settings, which your tools cannot change (such as `repo-required`, or `agent-tools` when the Agent needs that tool), does not fail this check. Nor does an empty Stop `name` or `type`: they come from the user, never from you. When the ask does not give them, add the Stop the ask needs with them empty, then ask the user for them, or name them as a problem only the user can fix.

## Stop

- All pass: tell the user the blueprint is done, and that the edits are unsaved until they save. Name each problem left that only the user can fix, and where to fix it: in the session settings, or in the Stop's Output name and Output type.
- A check fails and the fix is clear: fix it, then run this check again from step 1.
- A check fails and the fix would need a guess: ask the user, and do not say done.
