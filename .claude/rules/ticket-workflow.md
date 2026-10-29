# Ticket workflow

Every ticket from FD-03 on runs through `/workflows:feature` with these flags, and no others that
weaken verification:

```
/workflows:feature "<ticket text from the board>" --no-e2e --manual-test --auto-mode
```

1. **E2E is always off.** Pass `--no-e2e`. `e2e.enabled` is `false` in the plugin config. The
   Carousell test repos, BrowserStack and TCM don't apply to this repo.
2. **Unit tests are always written first (TDD).** Each failing test is seen failing before the code
   that makes it pass. Never pass `--no-tdd` or `--no-unit-tests`.
3. **Manual test is always on, driven by the AI.** Pass `--manual-test` and follow `manual-test.md`.
4. **One ticket, one branch, one PR.** Scope is the ticket's page on the board. Anything worth
   doing outside it is raised, not folded in.
5. **Chain tickets hands-off.** Run each ticket through PR, merge and the board note, then start
   the next one without asking. Stop only for an issue the user must unblock; close other unknowns
   yourself.

FD-01 and FD-02 were done directly, not through the workflow, because the workflow needs what they
set up.

## GitHub account

The repo is `sasmita22/flowdeck`. Run `gh auth switch -u sasmita22` before anything touches GitHub;
the work account is often left active. If that account isn't logged in on this machine, ask the
user to run `! gh auth login`.

## Plugin config

The workflows plugin is `carousell/agent-workflows-plugin`, enabled for this repo by
`.claude/settings.json`; Claude Code offers to install it when the folder is first trusted. It
reads `.claude/local/plugin.config.json`, which is gitignored: copy
`.claude/plugin.config.example.json` there on each machine. It sets `parentBranch` to `main` and
turns E2E off.

The plugin's run files stay out of git: `.claude/local/` and `.plugin-state/` are ignored, so a
run's state never leaves the machine it ran on. The board notes are what carries a ticket over.
