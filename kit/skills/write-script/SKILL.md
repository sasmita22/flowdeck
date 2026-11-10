---
name: write-script
description: How to check a Script node's command before it runs unattended - quoting, working folder, full paths, exit codes against the node's success and retry codes, and never waiting for input. Read before checking any Script node in a Flowdeck build.
---

# Check a Script

A Script node's command lives in `manifest.json`, not in a file, and no agent ever rewrites it. You check it; a wrong command stays as the node wrote it, never a question.

A question is only for a blueprint input: an empty required field or setting, a missing wire (a read with no writer, or a wait that can never end), or nodes that contradict each other. Everything else is decided inside the node's portion, never a question.

## How it runs

The runner starts `command` as a program, not through a shell, with each of `args` passed as its own argument, in the run's worktree (the repository folder `CLAUDE.md` names), with no terminal and no input. Spaces, globs, `$` and quotes reach the program as written. The orchestrator in plain Claude Code instead runs `command` followed by the shell-quoted `args` as one shell line.

- `successCodes`: exit codes that mean done. Default `[0]`.
- `retryCodes`: exit codes that mean try once more. Default `[2]`. At most 2 attempts.
- Any other exit code fails the node.

## Steps

1. Find the node: `PIECE script:<nodeId>` names it. Read its `settings` in `manifest.json`.
2. Check each point against the target repo's worktree:
   - Quoting: `command` is one program name, with no spaces or shell syntax, and each of `args` is one argument, so the command runs the same with no shell in Flowdeck and as the orchestrator's shell line.
   - Working folder: every relative path exists from the worktree root (use Glob).
   - Full paths: every program is one the repo provides (its scripts, its package manager's bin) or a standard tool; a repo-local program is called by its path.
   - Exit codes: the codes the command really gives for success and for a passing retry match `successCodes` and `retryCodes`.
   - Never waits for input: no prompt, pager, editor, watch mode, or confirmation without its non-interactive flag.
3. A problem found stays as the node wrote it: the command is the blueprint's.
4. Edit nothing. The only file you write is `build-report.json`.

## Checklist

- [ ] Every point in step 2 was checked against the worktree, not assumed.
- [ ] No problem became a question.
- [ ] The command and args are unchanged.
