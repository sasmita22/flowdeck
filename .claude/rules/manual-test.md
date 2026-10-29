# Manual test rules

The plugin's manual test knows Android, iOS and mobile web. **None of those apply here**: the
repo has a root `package.json`, so the plugin would otherwise guess mobile web, look for its dev
host and run each check twice. Use these rules instead.

## How to drive each part

| What changed      | How to drive it                                                                                                                                          | Evidence to save and read back                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Engine and CLI    | Run the `flowdeck` command against a throwaway repo created by `test/fixtures/tmp-repo.ts`                                                               | The command's output, `tmux capture-pane -p -t <session>`, and the files or database rows the check names |
| App screens       | `npm run drive -- <steps.json>`: launches the app with Playwright for Electron and runs click, type, wait-for-text and screenshot steps by `data-testid` | A screenshot and an accessibility snapshot per step, plus the app log                                     |
| The terminal pane | Open it through the drive script                                                                                                                         | The screenshot, checked against `tmux capture-pane` of the same session                                   |

## Rules

1. **Never real data.** Set `FLOWDECK_HOME` to a fresh temporary folder for every manual test.
   Name tmux sessions `fd-mt-*`.
2. **Every check can fail.** Each check has a `Fails if:` line. It passes only when the saved
   evidence, read back, shows the expected result. Running the steps is not a pass.
3. **Check every claim in two places.** A claim about the screen is confirmed in a second place:
   a node shown as done also has its `run_nodes` row marked done.
4. **Once, on the desktop app.** Each check runs once. Never mobile and desktop viewports.
5. **Keep live checks cheap.** Checks that start real Claude Code use the smallest model and the
   shortest prompt that proves the point.
6. **Leave nothing behind.** Afterwards, stop every `fd-mt-*` tmux session, delete the temporary
   `FLOWDECK_HOME` and any worktree the test made, and quit the app. Report anything that could
   not be cleaned up.
7. **No native dialogs.** Playwright can't click macOS file pickers or menus. Every v1 flow has an
   in-app way to do the same thing; manual checks use it.
8. **Where results go.** One row per check in the run's `implementation.md` (check id, what was
   driven, result, evidence file, one-line note), and a summary in the PR body. There is no Jira
   ticket to post to.
