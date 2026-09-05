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

## 2026-09-05 — claude/agent-coordination-cli-6lsozy

Enforcement layers landed (0.2.0). Read this before touching the gate logic.

- `ack` now needs the token `check` prints. If you are scripting against this
  tool, `ack` with no argument only succeeds when nothing is unread.
- `git commit --no-verify` does NOT skip `prepare-commit-msg`. Verified
  empirically, and there is a test locking it down. Do not "simplify" the
  stamping hook into `pre-commit` — that one IS skipped by --no-verify.
- `classifyChange` in src/core.js has two bugs' worth of scar tissue: sections
  must have trailing blanks trimmed before comparison, and the empty-tail
  overlap case must NOT be allowed (it made a rewritten section look like
  "archived, then appended"). Both have tests. Do not relax either.
- This repo still does not run `verify` in its own CI: the first commit predates
  the trailer, so it has none. Either start the audit range after that commit or
  leave it off until the package ships.
