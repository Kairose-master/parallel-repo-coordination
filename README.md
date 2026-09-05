# pairwarn

**Nobody pushes until they have read the shared note.**

A zero-dependency CLI that stops two agents — or two humans, or an agent and a
human — from silently clobbering each other's work in one git repository when
they have no shared memory and no message bus between them.

```sh
npx pairwarn note "Rewriting src/db/schema.ts wholesale — do not hand-edit it"
npx pairwarn check   # exits 1 in every other working copy until it is read
```

MIT licensed. No install step, no server, no account, no dependencies, no AI.

---

## Why this exists

This mechanism was built and proven inside another project, after the naive
version failed in a way that was easy to measure.

The naive version was a plain markdown file that every session was *supposed*
to read. One session wrote a specific, correct, timely warning into it. Another
session had that warning on screen — in a merge diffstat — for eleven minutes,
and then shipped exactly the defect the note described.

The note was right. It was current. It was visible. It was not read.

The fix was not "write better notes". The fix was to make the note **impossible
to skip**: a gate that refuses to let a commit or a push proceed until the note
has been read *in this exact working copy*. That gate is this tool.

It works precisely because it is dumb. It has no model of your repository, no
summarisation, no opinion about whether the note matters. It cannot be talked
out of refusing by a confident agent, because there is nothing in it to argue
with — only a byte comparison between what is in the file and what this working
copy has acknowledged.

## Why a note file, and not a lock service

A coordination server would be the obvious design. A file in the repo is the
better one:

- **git merge semantics are free conflict detection.** Two sessions appending
  to the same note file at the same time produce a merge conflict, in the exact
  place where their claims collide. You do not have to build that; you already
  have it.
- **Commit messages survive an agent losing its context.** Sessions end, context
  windows fill, containers get reclaimed. Anything held only in a session's head
  is gone. Anything committed is still there for the next one.
- **The note travels with the code.** It arrives on the same `git pull` as the
  change it warns about — never earlier, never later, never on a dashboard
  somebody had to remember to open.

A lock service has none of these properties, needs to be running, needs
credentials, and becomes one more thing that can be down when you push.

## Quickstart

Two commands. In the repository, once:

```sh
npx pairwarn init          # creates conversation.md, offers to install the hook
```

Then, whenever you are about to do something another session could trip over:

```sh
npx pairwarn note "Migration 0042 is half-applied on staging; don't run 0043 yet"
```

Everyone else's next push is refused until they have read it:

```
pairwarn: refusing — conversation.md has not been read in this working copy.

4 new lines in conversation.md:
  --------------------------------------------------------------------
  | ## 2026-01-03 — chore/migrations
  | 
  | Migration 0042 is half-applied on staging; don't run 0043 yet
  --------------------------------------------------------------------

Read the above, then record it:

    npx pairwarn ack 70b402fa66fa
```

## Commands

| Command | What it does |
| --- | --- |
| `pairwarn check` | The gate. Exit 1 with the new lines if the note file is unread here; exit 0 silently if it is clean, empty, missing, or there is no git working copy at all. |
| `pairwarn ack <token>` | Record the note file as read. The token is printed by `check`, below the text it shows you. |
| `pairwarn note "<text>"` | Append a dated, branch-stamped section and acknowledge it — writing a note is reading it. Reads stdin when given no text. |
| `pairwarn install-hook` | Write or extend a git hook that runs `check`. Idempotent; defaults to `pre-push`, `--hook <name>` for any other. |
| `pairwarn stamp` | Print the `Note-Ack` trailer for the current note, or write it into a commit message with `--commit-msg <file>`. |
| `pairwarn verify` | Audit `<base>..HEAD`: every commit must carry the digest of the note file as it stood in that commit. Run this in CI. |
| `pairwarn archive` | Move sections older than `--older-than <days>` (default 30) into a sibling archive file. |
| `pairwarn init` | Create the note file, print the wiring you need, and offer to install the hooks. |

Options: `--file <path>` (or the `NOTE_FILE` environment variable) to use a note
file other than `conversation.md`; `--base <ref>` for `verify`; `--commit-msg
<file>` for `stamp`; `--older-than <days>` for `archive`; `-y/--yes` and
`--no-hook` for `init`; `--help`, `--version`.

Exit codes: **0** clean · **1** refused, notes unread · **2** usage error.

## What actually stops someone who does not want to be stopped

A gate that only lives in a git hook is a suggestion. `.git/hooks/` is not
committed, anyone can delete it, and `git push --no-verify` walks straight past
`pre-push`. Pretending otherwise would make this tool a placebo, so it is built
in layers and each one is honest about its reach.

| Layer | Stops | Does not stop |
| --- | --- | --- |
| `check` in a `pre-push` hook | The ordinary case: you pull, a warning arrived, you push without reading | `git push --no-verify`; a deleted hook |
| `stamp` in a `prepare-commit-msg` hook | Committing without acknowledging — and **`git commit --no-verify` does not skip this hook**, unlike `pre-commit` | A deleted hook |
| `verify` in CI | Everything above, because it reads the commits themselves rather than trusting the working copy | Nothing, if the CI job is required |
| The ack token | Clearing a warning you were never shown | Someone who reads the text and ignores it |

The load-bearing piece is the commit trailer. `ack` records the note in `.git/`,
which CI cannot see — so `stamp` also writes a digest of the note into the
commit message:

```
Fix the payment retry loop

Note-Ack: 70b402fa66fa
```

`verify` then checks, for every commit in a range, that the trailer matches the
note file **as it stood in that commit**. A commit made with the hooks deleted
has no trailer. A commit that reused an old digest has a stale one. Both fail:

```
pairwarn: 1 commit in a1b2c3d..HEAD did not acknowledge conversation.md.

  bc05e757  bypassed the gate entirely
      expected Note-Ack: 70b402fa66fa
      no Note-Ack trailer (hook skipped, bypassed, or removed)
```

Make that job a required status check and the loop closes: the local hooks stay
a convenience, and the thing nobody can skip is the one doing the enforcing.

### Why `ack` takes a token

`check` prints the token *after* the note text, and `ack` refuses without it:

```
$ pairwarn ack
pairwarn: conversation.md has unread changes — acknowledge them by token.

    npx pairwarn check      # shows what is new, and prints the token
    npx pairwarn ack <token>

A bare `ack` cannot clear content you have not been shown.
```

This does not prove comprehension — nothing can, and this tool will not pretend
to. What it guarantees is narrower and is exactly what failed in the story
above: the token cannot be produced unless the warning text passed in front of
the reader. A note sitting unread on screen no longer clears the gate.

### Keeping the note readable

A note file that only grows becomes the unread wall it was meant to replace.
`pairwarn archive` moves sections older than 30 days into
`conversation.archive.md`:

```sh
npx pairwarn archive --older-than 30
```

Other working copies do **not** get a re-read prompt for this. `check` compares
section by section: when the only change is that already-acknowledged sections
disappeared from the top, it advances silently. Rewriting or deleting a section
someone has *not* read still refuses — quietly editing a warning out from under
somebody is the failure mode, not the fix.

## How the acknowledgement works

`ack` writes a snapshot of the current note file into `.git/pairwarn/`. That
location is deliberate:

- **It is never committed.** `.git/` is not part of the working tree, so an
  acknowledgement cannot be pushed, and nobody can acknowledge on another
  session's behalf.
- **It is per working copy.** A fresh clone — a new container, a new agent
  sandbox, a new laptop — has no snapshot, so it is a fresh reader and must read
  once before it can push. Linked worktrees each get their own.
- **It shows you only the delta.** `check` compares the snapshot to the file and
  prints the lines after the longest common prefix: on an append-only file that
  is exactly what was appended since you last read. You re-read the new section,
  not the whole history.

Removing or rewriting acknowledged lines also re-triggers the gate — quietly
editing a warning out from under someone is the failure mode, not the fix.

## Wiring it into a command nobody can skip

The gate only works if it sits inside something that already has to run. Which
command that is differs per repository, so wire it wherever yours is.

### 1. An npm / pnpm / yarn script

```json
{
  "scripts": {
    "test": "pairwarn check && vitest run",
    "build": "pairwarn check && tsc -p ."
  }
}
```

Add `pairwarn` as a devDependency if you want the local binary rather than
`npx`. Anyone who runs the tests before pushing — including any agent following
your contributing guide — hits the gate.

### 2. A git hook

Managed, idempotent, and safe to run repeatedly:

```sh
npx pairwarn install-hook                    # .git/hooks/pre-push
npx pairwarn install-hook --hook pre-commit  # or earlier in the loop
```

It appends a marked block to an existing hook rather than overwriting it, and
does nothing on a second run. To wire it by hand instead — for example with
husky, in `.husky/pre-push`:

```sh
npx pairwarn check
```

Or a raw `.git/hooks/pre-commit`:

```sh
#!/bin/sh
npx pairwarn check || exit 1
```

Hooks are per clone and not committed, which is a feature here: the same
property that makes acknowledgements honest makes the hook something each
working copy opts into. Put `install-hook` in your setup script or postinstall
if you want it automatic.

### 3. GitHub Actions

This is where the gate stops being optional. `verify` reads the commits, not the
working copy, so it works on a fresh CI checkout where no acknowledgement exists:

```yaml
name: pairwarn
on: pull_request

jobs:
  notes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # verify needs the base branch's history
      - run: npx pairwarn verify --base origin/${{ github.base_ref }}
```

Make it a required status check. Every commit on the branch must then carry the
digest of the note file as it stood in that commit — which is only true if
somebody acknowledged it before committing.

Note that `check` is the wrong command for a human pull-request build: a fresh
checkout has no acknowledgement, so `check` would fail every time by design.
`check` gates *working copies*; `verify` gates *history*. Use `check` in hooks
and local scripts, `verify` in CI.

## What goes in a note

Anything the next session could walk into without knowing. Short is fine.

```
## 2026-01-03 — feat/payments

Rewriting src/db/schema.ts wholesale. Do not hand-edit it; regenerate with
`npm run schema`. Migration 0042 is half-applied on staging.
```

Newest entries at the bottom. Append; do not rewrite the history above — other
working copies have acknowledged those lines, and rewriting them re-triggers
the gate for everyone.

Commit the note file. It is only useful because it arrives with the code.

## Design constraints

- **Zero runtime dependencies.** Node built-ins only (`fs/promises`,
  `child_process`, `crypto`, `path`, `url`, `util`). This runs in every
  contributor's commit and push path; it must not be a supply-chain liability
  itself.
- **Agent-agnostic.** It is a CLI. A human, a shell script, a CI job, or any
  coding agent that can run a command before committing uses it identically.
- **No intelligence anywhere in it.** No model, no summarisation, no heuristic
  about which notes matter. Deterministic refusal is the whole product.
- **Nothing outside the repository.** No server, no database, no dashboard, no
  network access at any point.

## Requirements

Node.js ≥ 18 and `git` on `PATH`. Outside a git working copy, `check` exits 0
and says nothing — a tarball or a `COPY` in a Dockerfile has nothing to gate.

## License

[MIT](LICENSE)
