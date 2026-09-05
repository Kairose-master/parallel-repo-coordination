# Changelog

All notable changes to this project are documented here. This project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
