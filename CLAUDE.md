# Flowdeck

A Mac app for building and running multi-step Claude Code work by drawing it: nodes, flows and
session containers on a canvas, compiled into a build and run turn by turn.

- Design and architecture: https://claude.ai/artifact/1nmGgGy252pLGCnUyLdE4W (see `#arch`)
- Work board, one page per ticket: https://claude.ai/artifact/1nmGgGy252pLGCnUyLdE4W#board

These rules are this repo's engineering standards. The workflows plugin reads them before its own
defaults.

## Agent rules

Every ticket from FD-03 on runs through `/workflows:feature` with these flags, and no others that
weaken verification:

```
/workflows:feature "<ticket text from the board>" --no-e2e --manual-test
```

1. **E2E is always off.** Pass `--no-e2e`. `e2e.enabled` is `false` in the plugin config. The
   Carousell test repos, BrowserStack and TCM don't apply to this repo.
2. **Unit tests are always written first (TDD).** Each failing test is seen failing before the code
   that makes it pass. Never pass `--no-tdd` or `--no-unit-tests`.
3. **Manual test is always on, driven by the AI.** Pass `--manual-test` and follow
   [Manual test rules](#manual-test-rules).
4. **One ticket, one branch, one PR.** Scope is the ticket's page on the board. Anything worth
   doing outside it is raised, not folded in.

FD-01 and FD-02 are done directly, not through the workflow, because the workflow needs what they
set up.

## Gates

| Gate                                            | Command                                        |
| ----------------------------------------------- | ---------------------------------------------- |
| Pre-PR (all of the below)                       | `npm run check`                                |
| Typecheck                                       | `npm run typecheck`                            |
| Lint, including the layer rule                  | `npm run lint`                                 |
| Formatting                                      | `npm run format:check` (fix: `npm run format`) |
| All unit and integration tests                  | `npm test`                                     |
| A single test file                              | `npx vitest run <file>`                        |
| Live tests (start real Claude Code, cost money) | `FLOWDECK_LIVE=1 npx vitest run <file>`        |
| Run the CLI                                     | `npx tsx src/cli/main.ts <args>`               |
| Drive the app (from FD-18)                      | `npm run drive -- <steps.json>`                |

`npm test` never runs live tests. CI runs `npm run check` on every PR.

## Architecture

Hexagonal (ports and adapters) with an event-driven run engine. Declarative UI with one-way data
flow.

### Layers

| Folder          | Holds                                                                                                             | May import                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src/core/`     | Pure logic: flow schema, node registry, validator, compiler, run state machine                                    | `core` only                                           |
| `src/ports/`    | Interfaces only: SessionHost, EventSource, Waiter, Store, ProcessRunner, Clock, FileSystem                        | `core`                                                |
| `src/adapters/` | Real implementations: tmux, claude-cli, hook-socket, sqlite, git, process, node-fs                                | `core`, `ports`                                       |
| `src/cli/`      | The `flowdeck` command and its composition root                                                                   | all of the above                                      |
| `src/app/`      | Electron: `main` (composition root, IPC), `engine` (utilityProcess), `preload` (typed bridge), `renderer` (React) | all of the above; the renderer only through `preload` |

`test/` may import any layer. The layer rule is enforced by ESLint (`eslint-plugin-boundaries`,
with `eslint-import-resolver-typescript` so `.js` import paths resolve to `.ts` files; without the
resolver the rule silently passes every import). Never disable it to make an import work; move the
code to the right layer instead.

### Rules

- **No I/O in `core`.** Files, processes, network, time and randomness go through a port.
- **Every port has a fake** in `test/fakes/`. Core logic is tested against fakes, not real tools.
- **Constructor injection, no DI framework.** Classes take their ports in the constructor, for
  example `new Runner({ sessions, events, store, waiter })`. Real adapters are created only in the
  composition roots, `src/cli/main.ts` and `src/app/main`.
- **One folder per node type** in `src/core/nodes/<type>/`: settings schema, ports, compile,
  execute. A new node type is a new folder; `src/core/nodes/registry.ts` lists them.
- **The zod schema is the single source of truth** for a type, its validation and its settings
  form.
- **The runner is a state machine.** Every allowed move between node states is in one transition
  table; an illegal move throws.
- **Events are append-only.** A node's status is derived from its events; nothing edits history.
- **UI state lives in Zustand stores.** React draws from state; nothing edits the screen by hand.
  Canvas edits are command objects with do and undo.
- **The renderer has no Node access.** `contextIsolation` is on; everything goes through the typed
  preload bridge.
- **Every interactive control has a `data-testid`.**
- **All Flowdeck data lives under `$FLOWDECK_HOME`** (default `~/.flowdeck`): the database,
  builds and the event socket. Builds never write into the repo being worked on.
- **Flowdeck only touches its own tmux sessions**, named `fd-*`.

## Tech stack

TypeScript (strict) on Node 24 LTS (`.nvmrc`) · Electron with Electron Forge and its Vite plugin · React,
React Flow (`@xyflow/react`), Zustand · `@xterm/xterm`, node-pty, tmux · zod · better-sqlite3 with
plain SQL migrations · Vitest · Playwright for Electron · ESLint, Prettier.

Packages: npm, exact versions, lockfile committed. `@electron/rebuild` runs after install so
better-sqlite3 and node-pty match Electron.

## Tests

| Level       | What                                                                 | Runs                        |
| ----------- | -------------------------------------------------------------------- | --------------------------- |
| Unit        | One piece against fakes                                              | `npm test`, seconds, free   |
| Integration | An adapter against the real tool (tmux, git, SQLite)                 | `npm test`                  |
| Live        | Real Claude Code on a throwaway repo; file name ends `.live.test.ts` | Only with `FLOWDECK_LIVE=1` |
| E2E         | The app through Playwright for Electron, in `e2e/`                   | `npx playwright test`       |

- A test that cannot fail is not a test. When adding a check, make it fail once on purpose and
  watch it fail.
- Live tests use the smallest model and the shortest prompt that proves the point.

## Manual test rules

The plugin's manual test knows Android, iOS and mobile web. **None of those apply here**: the
repo has a root `package.json`, so the plugin would otherwise guess mobile web, look for its dev
host and run each check twice. Use these rules instead.

### How to drive each part

| What changed             | How to drive it                                                                                                                                          | Evidence to save and read back                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Engine and CLI           | Run the `flowdeck` command against a throwaway repo created by `test/fixtures/tmp-repo.ts`                                                               | The command's output, `tmux capture-pane -p -t <session>`, and the files or database rows the check names |
| App screens (from FD-18) | `npm run drive -- <steps.json>`: launches the app with Playwright for Electron and runs click, type, wait-for-text and screenshot steps by `data-testid` | A screenshot and an accessibility snapshot per step, plus the app log                                     |
| The terminal pane        | Open it through the drive script                                                                                                                         | The screenshot, checked against `tmux capture-pane` of the same session                                   |

### Rules

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

## Conventions

- Ticket ids: `FD-NN`, matching the board.
- Branches: `feature/FD-NN-<slug>`, cut from `main`.
- Commit and PR titles: conventional, ending with the ticket id, for example
  `feat(engine): start tmux sessions (FD-03)`.
- Code explains itself: no comments that restate the code, and no ticket ids in code.
- The plugin's run files stay out of git: `.claude/local/` and `.plugin-state/` are ignored.

## Plugin config

Copy `.claude/plugin.config.example.json` to `.claude/local/plugin.config.json` on each machine.
It sets `parentBranch` to `main` and turns E2E off.
