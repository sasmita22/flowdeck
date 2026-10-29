# Flowdeck

A Mac app for building and running multi-step Claude Code work by drawing it: nodes, flows and
session containers on a canvas, compiled into a build and run turn by turn.

Design and architecture: https://claude.ai/artifact/1nmGgGy252pLGCnUyLdE4W (see `#arch`).

These rules are this repo's engineering standards.

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
| Drive the app                                   | `npm run drive -- <steps.json>`                |

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
- Manual tests follow [`.claude/rules/manual-test.md`](.claude/rules/manual-test.md).

## Conventions

- Ticket ids: `FD-NN`, matching the board.
- Branches: `feature/FD-NN-<slug>`, cut from `main`.
- **`main` only changes through a merged PR.** A GitHub ruleset protects it, with no bypass.
- Commit and PR titles: conventional, ending with the ticket id, for example
  `feat(engine): start tmux sessions (FD-03)`.
- Code explains itself: no comments that restate the code, and no ticket ids in code.
