# Manual test rules

The plugin's manual test knows Android, iOS and mobile web. **None of those apply here**: the
repo has a root `package.json`, so the plugin would otherwise guess mobile web, look for its dev
host and run each check twice. Use these rules instead.

## How to drive each part

| What changed      | How to drive it                                                                                                                                                                                                                                                                                                                                                                                         | Evidence to save and read back                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine            | Build a blueprint and run it in the app with `npm run drive -- <steps.json>`                                                                                                                                                                                                                                                                                                                            | A screenshot and an accessibility snapshot per step, the app log, `tmux capture-pane -p -t <session>` of the run's session, and the database rows the check names (for example `run_nodes`) |
| App screens       | `npm run drive -- <steps.json>`: launches the app with Playwright for Electron and runs these steps, finding elements by `data-testid`: `click`, `click-at` (a point in px from the element's top-left; `canvas` for canvas coordinates), `right-click`, `type`, `select` (by `value` or `label`), `wait-for-text`, `screenshot`, `drag`, `press`, `close-window`, `relaunch`, `resize-window`, `pause` | A screenshot and an accessibility snapshot per step, plus the app log                                                                                                                       |
| The terminal pane | Open it through the drive script                                                                                                                                                                                                                                                                                                                                                                        | The screenshot, checked against `tmux capture-pane` of the same session                                                                                                                     |

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
   `FLOWDECK_HOME` and any worktree the test made, and quit the app. Then check `~/.claude.json`
   for `projects` entries whose folders no longer exist, and remove the ones the run created.
   Report anything that could not be cleaned up.
7. **The app stays hidden.** Drive runs started by an agent keep the window hidden (`CLAUDECODE=1`),
   so nothing appears on the user's screen. To watch a run, set `FLOWDECK_SHOW_WINDOW=1`.
8. **No native dialogs.** Playwright can't click macOS file pickers or menus. Every v1 flow has an
   in-app way to do the same thing; manual checks use it.
9. **Where results go.** One row per check in the run's `implementation.md` (check id, what was
   driven, result, evidence file, one-line note), and a summary in the PR body. There is no Jira
   ticket to post to.
10. **Real Claude Code runs on a temporary Claude config.** `npm run drive` makes one inside
    `FLOWDECK_HOME` and starts the app on it, so a drive never writes to `~/.claude` or
    `~/.claude.json`. Start drives that run real Claude Code through `npm run drive`, and never
    point one at `~/.claude`.
11. **One job per Agent node.** When a check needs several Agent nodes, give each a different job.
    The build merges Agent nodes that do the same job into one piece, which hides what each node
    does on its own.
