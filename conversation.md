# Shared working notes

Every session that touches this repository appends a short, dated,
branch-stamped section to the bottom of this file before it pushes: anything
another session could trip over. Files being rewritten wholesale, migrations in
flight, assumptions that are about to stop being true.

    npx pairwarn check           # refuses until this file has been read here
    npx pairwarn ack             # records that you have read it
    npx pairwarn note "..."      # append a section (writing is also reading)

The acknowledgement is stored in .git/ and is never committed, so a fresh clone
is a fresh reader. Append at the bottom; do not rewrite history above.

## 2026-09-05 — claude/agent-coordination-cli-6lsozy

First entry, and the shape every later one should follow.

This repository *is* pairwarn: the tool that writes this file. Two things a
session here could trip over:

- The package is not published to npm yet, so the `pre-push` hook that
  `install-hook` writes cannot fall back to `npx --yes pairwarn` in this
  working copy. The hook is therefore deliberately NOT installed here. Run
  `npm test` (or `node bin/cli.js check`) instead until the package ships.
- `.git/pairwarn/` holds each working copy's acknowledgement. If you are
  debugging the gate and want to see a first-read refusal again, delete that
  directory — never add an "unack" command to work around it.
