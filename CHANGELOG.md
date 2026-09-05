# Changelog

All notable changes to this project are documented here. This project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-05

Closes the gap between "the gate refuses" and "the gate cannot be walked past".
A hook in `.git/` is a courtesy: it is not committed, anyone can delete it, and
`git push --no-verify` skips `pre-push` outright. This release moves the proof
into the commits, where CI can audit it.

### Added

- `pairwarn stamp` — writes a `Note-Ack: <digest>` trailer into a commit
  message (`--commit-msg <file>`) or prints it. Refuses when the note is
  unread, which aborts the commit.
- `pairwarn verify [--base <ref>]` — audits `<base>..HEAD`: every commit must
  carry the digest of the note file as it stood in that commit. Catches a
  missing trailer (hooks deleted) and a stale one (an old digest reused). This
  is the enforceable layer; run it as a required CI check.
- `install-hook --hook prepare-commit-msg` — installs the stamping hook.
  Notably, `git commit --no-verify` does **not** skip `prepare-commit-msg`, so
  this gate holds where `pre-commit` would not. `init` now installs both hooks.
- `pairwarn archive [--older-than <days>]` — moves sections older than the
  cutoff (default 30 days) into a sibling archive file, so the active note
  stays short enough that people finish reading it. Sections without a
  parseable date are kept rather than guessed at.

### Changed

- `ack` now requires the token that `check` prints below the note text. A bare
  `ack` no longer clears unread content. This does not prove comprehension —
  nothing can — but the token cannot be produced unless the warning passed in
  front of the reader, which is precisely what failed in the story behind this
  tool. `ack` stays idempotent when there is nothing unread.
- `check` compares section by section rather than line by line. When the only
  change is that already-acknowledged sections were archived off the top, it
  advances silently instead of demanding a re-read of everything that remains.
  Rewriting or removing an unread section still refuses.

### Fixed

- A section that stopped being the last one in the file gained a trailing blank
  line and compared unequal, so a plain append could be reported as a rewrite.
- A rewritten section could be misclassified as "archived, then appended",
  which would have let a quietly edited warning through — the exact case the
  archive support was meant to leave closed.
- `EPIPE` when output is cut off by a pipe (`pairwarn check | head`) crashed the
  process instead of exiting cleanly. In a hook that turned a closed pipe into
  a blocked push.

## [0.1.0] — 2026-09-05

First release. A standalone, zero-dependency generalisation of a coordination
gate that was built and proven inside another project.

### Added

- `pairwarn check` — refuses (exit 1) until the note file has been read in the
  current working copy, printing only the lines that are new since the last
  acknowledgement. Exits 0 silently when the note file is clean, empty or
  missing, or when there is no git working copy at all.
- `pairwarn ack` — records the current note content as read. The record lives
  in `.git/pairwarn/`, so it is never committed, is per working copy (linked
  worktrees included), and cannot be made on another session's behalf.
- `pairwarn note "<text>"` — appends a dated, branch-stamped section to the
  note file and acknowledges it in the same step. Reads stdin when given no
  text; `--note` is accepted as an alias.
- `pairwarn install-hook` — writes or extends a git hook that runs `check`.
  Idempotent, appends a marked block rather than overwriting an existing hook,
  and defaults to `pre-push` (`--hook <name>` for others).
- `pairwarn init` — creates the note file with a header, acknowledges it,
  prints the npm-script and instruction-file wiring, and offers to install the
  hook.
- `NOTE_FILE` environment variable and `--file <path>` to use a note file other
  than `conversation.md`. Each note file gets its own acknowledgement.
