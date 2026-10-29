# Flowdeck

A Mac app for building and running multi-step Claude Code work by drawing it.

Every step is a node, a saved group of nodes is a flow, and a session container marks what runs
inside one Claude Code session. You press Run, and Flowdeck drives each session turn by turn,
showing every question and approval in the app.

> **Status:** early. v1 (one session, drawn and run from the app) is being built ticket by ticket.
> Nothing runs yet beyond the toolchain.

## Requirements

- macOS
- Node 24 (see `.nvmrc`)
- [Claude Code](https://claude.com/claude-code)
- tmux (`brew install tmux`)
- GitHub CLI (`brew install gh`), for ticket work

## Getting started

```sh
nvm use
npm install
npm run check
```

## Commands

| Command                                 | What it does                                             |
| --------------------------------------- | -------------------------------------------------------- |
| `npm run check`                         | Typecheck, lint (with the layer rule), format, tests     |
| `npm test`                              | Unit and integration tests                               |
| `npx vitest run <file>`                 | One test file                                            |
| `FLOWDECK_LIVE=1 npx vitest run <file>` | Live tests that start real Claude Code (they cost money) |
| `npm run format`                        | Format everything with Prettier                          |

## How the code is organised

```
src/
  core/       pure logic: flow schema, node types, validator, compiler, run state machine
  ports/      interfaces: SessionHost, EventSource, Waiter, Store, ...
  adapters/   real implementations: tmux, Claude Code, hook socket, SQLite, git
  cli/        the flowdeck command
  app/        the Electron app: main, engine, preload, renderer
test/fakes/   a fake for every port
```

`core` never imports from `adapters`; ESLint enforces the layers. The full architecture, the
stack and the rules are in [CLAUDE.md](CLAUDE.md).

## How work is done

Work is split into small tickets (`FD-01`, `FD-02`, …), each with its own steps and acceptance
tests. From FD-03 on, each ticket runs through `/workflows:feature` with E2E off, tests written
first, and an AI-driven manual test. The agent rules are in [`.claude/rules/`](.claude/rules/).
