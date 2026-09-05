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

    npx pairwarn ack
```

## Commands

| Command | What it does |
| --- | --- |
| `pairwarn check` | The gate. Exit 1 with the new lines if the note file is unread here; exit 0 silently if it is clean, empty, missing, or there is no git working copy at all. |
| `pairwarn ack` | Record the note file as read, in this working copy. |
| `pairwarn note "<text>"` | Append a dated, branch-stamped section and acknowledge it — writing a note is reading it. Reads stdin when given no text. |
| `pairwarn install-hook` | Write or extend a git hook that runs `check`. Idempotent; defaults to `pre-push`, `--hook <name>` for any other. |
| `pairwarn init` | Create the note file, print the wiring you need, and offer to install the hook. |

Options: `--file <path>` (or the `NOTE_FILE` environment variable) to use a note
file other than `conversation.md`; `-y/--yes` and `--no-hook` for `init`;
`--help`, `--version`.

Exit codes: **0** clean · **1** refused, notes unread · **2** usage error.

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

The gate belongs in **jobs that push**, which on CI means automation and agent
jobs:

```yaml
- name: Refuse to push over an unread note
  run: npx pairwarn check
```

Be deliberate about this one. A fresh CI checkout has no acknowledgement, so on
an ordinary human pull-request build `check` would fail every time by design —
that is the correct behaviour for a *working copy*, and useless as a PR status.
Use it in a job where the runner is itself the working copy doing the work
(an automation job that commits and pushes), and rely on the pre-push hook for
everyone else.

If you also want a PR-level rule, this needs no extra tooling — fail a PR that
touches shared surface without leaving a note:

```yaml
- name: Require a note for changes to shared surface
  run: |
    base="origin/${{ github.base_ref }}"
    git fetch -q origin "${{ github.base_ref }}"
    changed=$(git diff --name-only "$base"...HEAD)
    echo "$changed" | grep -qE '^(src/db/|src/api/)' || exit 0
    echo "$changed" | grep -qx 'conversation.md' || {
      echo "Shared surface changed without a note. Run: npx pairwarn note \"...\""
      exit 1
    }
```

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
  `child_process`, `path`, `url`, `util`). This runs in every contributor's
  pre-push path; it must not be a supply-chain liability itself.
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
