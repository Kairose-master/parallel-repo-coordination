# Working in this repository

<!-- pairwarn -->
This repository may be worked on by more than one session at a time.
Before you commit or push, run:

    node bin/cli.js check

It exits non-zero until `conversation.md` has been read in this working
copy, and prints only what is new since your last read, plus the token that
clears it (`node bin/cli.js ack <token>`).

When you change something another session could trip over, say so:

    node bin/cli.js note "what the next session would otherwise walk into"

(Once this package is published, both become `npx pairwarn ...`.)

## Layout

    bin/cli.js         argument parsing and dispatch only
    src/core.js        git discovery, note IO, acknowledgement state, hook text
    src/commands.js    one function per subcommand, each returning an exit code
    test/              node:test, black-box: the CLI is spawned as a subprocess

## The layers, and what each one is worth

    check  + pre-push hook           courtesy: `--no-verify` and `rm` defeat it
    stamp  + prepare-commit-msg      stronger: --no-verify does NOT skip this hook
    verify + CI required check       enforcement: reads commits, not the working copy
    ack token                        stops clearing text you were never shown

Never describe a lower layer as if it were a higher one. The tool is only
worth anything if its claims about itself are exact.

## Rules that are not negotiable

- **Zero runtime dependencies.** Node built-ins only. This tool runs in other
  people's pre-push path; adding a dependency makes it a supply-chain risk.
- **No model, no network, no cleverness.** The gate works because it is
  deterministic and cannot be argued with. Do not add summarisation, severity
  scoring, or anything that decides a note is unimportant.
- **No way to acknowledge on someone else's behalf.** The record lives in
  `.git/` for a reason. No shared state, no `--force`, no `unack`, and no flag
  that skips the token.
- **`check` must stay silent and exit 0 when there is nothing to gate** —
  no git working copy, or no note file. It runs on every push everywhere.

## Tests

    npm test

They spawn the real binary against throwaway git repositories, including one
that performs an actual `git push` through an installed hook. Keep them
black-box; behaviour is the contract.
