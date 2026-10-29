# Session handoff

Work carries between sessions through the board's ticket notes, not chat or git history. They
live in the shared database of the board artifact,
https://claude.ai/artifact/1nmGgGy252pLGCnUyLdE4W (work board: `#board`, one page per ticket):
collection `tickets`, one document per ticket (`t03` for FD-03), with `status` (`todo`, `doing`,
`done`) and `notes`, a list of `{ date, text }`.

## When the user asks to end the session

1. Commit and push every branch worked on, so the work survives a change of machine. Local run
   files in `.claude/local/` do not travel.
2. Append a dated note to every ticket worked on: what was done, the branch, commits, whether
   they are pushed, open PRs, what is still open, and the exact next step.
3. Set the ticket's `status` to match. A ticket is `done` only once its PR is merged into
   `main`; until then it stays `doing`.
4. Audit the notes on every `done` and `doing` ticket for stale claims. Never rewrite an old
   note; append one that names what is stale and what is true now.
5. Read the notes back to confirm they landed.

## When a new session starts and the user says "continue"

1. Switch the GitHub account and check the plugin config exists (see `ticket-workflow.md`). On a
   fresh clone, also run the README's getting-started steps (`nvm use`, `npm install`).
2. Read the notes of the latest `doing` ticket, or the latest `done` one if none is in progress.
3. `git fetch` and check out the branch the notes name, or an up-to-date `main`.
4. Take the next step from those notes. A ticket's commit on `main` doesn't make it done; its
   `status` and notes decide. If the notes describe a run mid-workflow but its
   `.claude/local/<ticket>/` folder is missing, this is a new machine: start `/workflows:feature`
   for the ticket again on the pushed branch rather than expecting a resume.
5. If the next ticket depends on one still `doing`, say so before starting it.
