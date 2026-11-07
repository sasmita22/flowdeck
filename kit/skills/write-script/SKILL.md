---
name: write-script
description: How to check a Script node's command before it runs unattended - quoting, working folder, full paths, exit codes against the node's success and retry codes, and never waiting for input. Read before checking any Script node in a Flowdeck build.
---

# Check a Script

A Script node's command lives in `manifest.json`, not in a file, and no agent ever rewrites it. You check it; a wrong command becomes a question.

## How it runs

The runner runs `command` through `sh -c`, with each of `args` passed as its own argument, in the run's worktree (the repository folder `CLAUDE.md` names), with no terminal and no input.

- `successCodes`: exit codes that mean done. Default `[0]`.
- `retryCodes`: exit codes that mean try once more. Default `[2]`. At most 2 attempts.
- Any other exit code fails the node.

## Steps

1. Find the node: `PIECE script:<nodeId>` names it. Read its `settings` in `manifest.json`.
2. Check each point against the target repo's worktree:
   - Quoting: spaces, globs, `$` and quotes in the command and args mean what the node intends.
   - Working folder: every relative path exists from the worktree root (use Glob).
   - Full paths: every program is one the repo provides (its scripts, its package manager's bin) or a standard tool; a repo-local program is called by its path.
   - Exit codes: the codes the command really gives for success and for a passing retry match `successCodes` and `retryCodes`.
   - Never waits for input: no prompt, pager, editor, watch mode, or confirmation without its non-interactive flag.
3. For every problem, add a question with the node's id: what is wrong, the evidence (the repo file or the exit-code behaviour), and the change you would suggest.
4. Edit nothing. The only file you write is `build-report.json`.

## Checklist

- [ ] Every point in step 2 was checked against the worktree, not assumed.
- [ ] Each problem is one question naming the node, with its evidence.
- [ ] The command and args are unchanged.
