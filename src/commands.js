/**
 * pairwarn subcommands. Each returns a process exit code:
 *   0 = fine, 1 = refused (unread notes), 2 = usage error.
 */

import { writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BIN_NAME,
  TRAILER_KEY,
  applyTrailer,
  archiveFileName,
  classifyChange,
  digest,
  gitOutput,
  joinNote,
  partitionByAge,
  readTrailer,
  today,
  trailerLine,
  MAX_PRINTED_LINES,
  NOTE_HEADER,
  ackKey,
  ackPaths,
  appendSection,
  currentBranch,
  exists,
  findRepo,
  formatSection,
  hooksDir,
  installHook,
  newLines,
  noteFileName,
  notePath,
  readAck,
  readText,
  splitLines,
  writeAck,
} from './core.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

/** Everything a command needs about where it is running. */
async function context(opts) {
  const repo = await findRepo(opts.cwd);
  if (!repo) return null;
  const name = noteFileName(process.env, opts.file);
  const file = notePath(repo.root, name);
  return {
    ...repo,
    name,
    file,
    rel: path.relative(repo.root, file) || name,
    key: ackKey(repo.root, name),
  };
}

function requireRepo(ctx) {
  if (ctx) return true;
  err(`${BIN_NAME}: not inside a git working copy — nothing to coordinate.`);
  return false;
}

/* ---------------------------------------------------------------- check --- */

export async function check(opts = {}) {
  const ctx = await context(opts);
  // Not a git repo at all: a tarball or a Docker COPY has nothing to gate.
  if (!ctx) return 0;

  const current = await readText(ctx.file);
  if (current === null || current.trim() === '') return 0;

  const { content: acked, info } = await readAck(ctx.gitDir, ctx.key);
  const change = classifyChange(acked, current);

  if (change.kind === 'clean') return 0;

  // Only already-read sections were archived off the top. You have seen
  // everything that remains, so advance the snapshot and stay out of the way.
  if (change.kind === 'archived') {
    const branch = await currentBranch(ctx.root);
    await writeAck(ctx.gitDir, ctx.key, current, { branch, via: 'archive' });
    return 0;
  }

  const token = digest(current);

  err('');
  err(`${BIN_NAME}: refusing — ${ctx.rel} has not been read in this working copy.`);
  err('');
  if (change.kind === 'first') {
    err(`This is a fresh reader. Another session may have left something here`);
    err(`that you are about to walk straight into.`);
  } else {
    const when = info?.ackedAt ? info.ackedAt.slice(0, 19).replace('T', ' ') : 'your last read';
    err(`${ctx.rel} changed since ${when} UTC.`);
  }
  err('');

  if (change.kind === 'rewritten') {
    err(`  Acknowledged lines were changed or removed — not appended.`);
    err(`  Open ${ctx.rel} and read it, then check what \`git diff\` says about it.`);
  } else {
    const n = change.added.length;
    if (change.archived) err(`(${change.archived} older section(s) archived — you had already read those.)`);
    err(`${n} new line${n === 1 ? '' : 's'} in ${ctx.rel}:`);
    err('  ' + '-'.repeat(68));
    for (const line of change.added.slice(0, MAX_PRINTED_LINES)) err(`  | ${line}`);
    if (n > MAX_PRINTED_LINES) {
      err(`  | ... ${n - MAX_PRINTED_LINES} more lines — open ${ctx.rel}`);
    }
    err('  ' + '-'.repeat(68));
  }

  err('');
  err(`Read the above, then record it with the token printed below it:`);
  err('');
  err(`    npx ${BIN_NAME} ack ${token}`);
  err('');
  err(`The token is derived from the text you were just shown, so it cannot be`);
  err(`produced without that text passing in front of you. The record lives in`);
  err(`.git/ and is never committed: a fresh clone reads again.`);
  err('');
  return 1;
}

/* ------------------------------------------------------------------ ack --- */

export async function ack(token, opts = {}) {
  const ctx = await context(opts);
  if (!requireRepo(ctx)) return 2;

  const current = await readText(ctx.file);
  if (current === null) {
    out(`${BIN_NAME}: ${ctx.rel} does not exist — nothing to acknowledge.`);
    return 0;
  }

  const { content: acked } = await readAck(ctx.gitDir, ctx.key);
  const change = classifyChange(acked, current);
  const expected = digest(current);

  if (change.kind !== 'clean' && change.kind !== 'archived') {
    const given = String(token ?? '').trim().toLowerCase();
    if (!given) {
      err(`${BIN_NAME}: ${ctx.rel} has unread changes — acknowledge them by token.`);
      err('');
      err(`    npx ${BIN_NAME} check      # shows what is new, and prints the token`);
      err(`    npx ${BIN_NAME} ack <token>`);
      err('');
      err(`A bare \`ack\` cannot clear content you have not been shown.`);
      return 1;
    }
    if (given !== expected) {
      err(`${BIN_NAME}: that token does not match the current ${ctx.rel}.`);
      err(`  ${ctx.rel} changed again since you ran check. Run it once more.`);
      return 1;
    }
  }

  const branch = await currentBranch(ctx.root);
  const { snapshot } = await writeAck(ctx.gitDir, ctx.key, current, { branch, digest: expected });
  const n = splitLines(current).length;
  out(`${BIN_NAME}: acknowledged ${ctx.rel} (${n} line${n === 1 ? '' : 's'}, ${expected}).`);
  out(`  recorded in ${path.relative(ctx.root, snapshot) || snapshot} — not committed`);
  return 0;
}

/* ----------------------------------------------------------------- note --- */

export async function note(text, opts = {}) {
  const ctx = await context(opts);
  if (!requireRepo(ctx)) return 2;

  const body = String(text ?? '').trim();
  if (!body) {
    err(`${BIN_NAME}: nothing to write.`);
    err(`usage: ${BIN_NAME} note "what another session could trip over"`);
    return 2;
  }

  const branch = await currentBranch(ctx.root);
  const existing = await readText(ctx.file);
  const section = formatSection(body, branch);
  const updated = appendSection(existing, section);
  await writeFile(ctx.file, updated, 'utf8');

  // Writing a note is reading it: acknowledge in the same breath.
  await writeAck(ctx.gitDir, ctx.key, updated, { branch, digest: digest(updated) });

  out(`${BIN_NAME}: appended to ${ctx.rel} and acknowledged.`);
  out('');
  for (const line of splitLines(section)) out(`  | ${line}`);
  out('');
  out(`Commit ${ctx.rel} so the note travels with the code it warns about.`);
  return 0;
}

/* --------------------------------------------------------- install-hook --- */

export async function installHookCommand(opts = {}) {
  const ctx = await context(opts);
  if (!requireRepo(ctx)) return 2;

  const hookName = opts.hook || 'pre-push';
  const dir = await hooksDir(ctx.root);
  const { action, file } = await installHook(dir, hookName);
  const shown = path.relative(ctx.root, file) || file;

  if (action === 'already-installed') {
    out(`${BIN_NAME}: ${hookName} hook already installed (${shown}) — nothing to do.`);
  } else if (action === 'created') {
    out(`${BIN_NAME}: wrote ${hookName} hook (${shown}).`);
  } else {
    out(`${BIN_NAME}: appended the gate to your existing ${hookName} hook (${shown}).`);
  }
  out(`  git ${hookName} now refuses until ${ctx.rel} has been read here.`);
  return 0;
}

/* ---------------------------------------------------------------- stamp --- */

/**
 * Emit (or write into a commit message) the trailer that proves the note file
 * was acknowledged at this content. This is what makes the acknowledgement
 * auditable from CI, where `.git/pairwarn/` does not exist.
 */
export async function stamp(opts = {}) {
  const ctx = await context(opts);
  if (!ctx) return 0;

  const current = await readText(ctx.file);
  if (current === null || current.trim() === '') return 0;

  const { content: acked } = await readAck(ctx.gitDir, ctx.key);
  const change = classifyChange(acked, current);
  if (change.kind !== 'clean' && change.kind !== 'archived') {
    err(`${BIN_NAME}: refusing to stamp — ${ctx.rel} has not been read here.`);
    err('');
    err(`    npx ${BIN_NAME} check`);
    err('');
    return 1;
  }

  const value = digest(current);

  if (!opts.commitMsg) {
    out(trailerLine(value));
    return 0;
  }

  const message = (await readText(opts.commitMsg)) ?? '';
  await writeFile(opts.commitMsg, applyTrailer(message, value), 'utf8');
  return 0;
}

/* --------------------------------------------------------------- verify --- */

/**
 * CI-side audit. A local hook is a courtesy that `--no-verify` skips and that
 * anyone can delete; this reads the commits themselves, so it cannot be
 * bypassed from a working copy.
 */
export async function verify(opts = {}) {
  const ctx = await context(opts);
  if (!requireRepo(ctx)) return 2;

  const base = opts.base || 'HEAD~1';
  let range;
  try {
    const from = await gitOutput(['rev-parse', '--verify', `${base}^{commit}`], ctx.root);
    range = `${from}..HEAD`;
  } catch {
    err(`${BIN_NAME}: cannot resolve base ref "${base}".`);
    err(`  In CI, fetch the base branch first, then pass --base origin/<branch>.`);
    return 2;
  }

  const listed = await gitOutput(['rev-list', '--no-merges', range], ctx.root);
  const commits = listed ? listed.split('\n') : [];
  if (commits.length === 0) {
    out(`${BIN_NAME}: no commits in ${range} to verify.`);
    return 0;
  }

  const offenders = [];
  for (const sha of commits) {
    let noteAtCommit;
    try {
      noteAtCommit = await gitOutput(['show', `${sha}:${ctx.rel}`], ctx.root, { trim: false });
    } catch {
      continue; // The note file does not exist at this commit: nothing to prove.
    }
    if (noteAtCommit.trim() === '') continue;

    const message = await gitOutput(['log', '-1', '--format=%B', sha], ctx.root, { trim: false });
    const found = readTrailer(message);
    const expected = digest(noteAtCommit);
    if (found === expected) continue;

    const subject = await gitOutput(['log', '-1', '--format=%s', sha], ctx.root);
    offenders.push({ sha: sha.slice(0, 8), subject, found, expected });
  }

  if (offenders.length === 0) {
    out(`${BIN_NAME}: ${commits.length} commit${commits.length === 1 ? '' : 's'} verified — every one acknowledges ${ctx.rel}.`);
    return 0;
  }

  err('');
  err(`${BIN_NAME}: ${offenders.length} commit${offenders.length === 1 ? '' : 's'} in ${range} did not acknowledge ${ctx.rel}.`);
  err('');
  for (const o of offenders) {
    err(`  ${o.sha}  ${o.subject}`);
    err(`      expected ${TRAILER_KEY}: ${o.expected}`);
    err(`      ${o.found ? `found    ${TRAILER_KEY}: ${o.found}  (stale — the note changed)` : `no ${TRAILER_KEY} trailer (hook skipped, bypassed, or removed)`}`);
  }
  err('');
  err(`Each commit must carry the digest of ${ctx.rel} as it stood in that commit.`);
  err(`Read the note, acknowledge it, and re-stamp the commits:`);
  err('');
  err(`    npx ${BIN_NAME} check && npx ${BIN_NAME} ack <token>`);
  err(`    git rebase --exec 'npx ${BIN_NAME} stamp --commit-msg .git/COMMIT_EDITMSG' ${base}`);
  err('');
  err(`Or install the hook so it happens on its own:`);
  err(`    npx ${BIN_NAME} install-hook --hook prepare-commit-msg`);
  err('');
  return 1;
}

/* -------------------------------------------------------------- archive --- */

/**
 * Move sections older than a cutoff into a sibling archive file. A note file
 * nobody finishes reading is the failure this whole tool exists to prevent,
 * so keeping the active file short is part of the mechanism, not housekeeping.
 */
export async function archive(opts = {}) {
  const ctx = await context(opts);
  if (!requireRepo(ctx)) return 2;

  const current = await readText(ctx.file);
  if (current === null || current.trim() === '') {
    out(`${BIN_NAME}: ${ctx.rel} is empty — nothing to archive.`);
    return 0;
  }

  const days = Number.isFinite(opts.days) ? opts.days : 30;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoff = today(new Date(cutoffMs));

  const { header, old, keep } = partitionByAge(current, cutoff);
  if (old.length === 0) {
    out(`${BIN_NAME}: nothing in ${ctx.rel} is older than ${days} days.`);
    return 0;
  }

  const archiveName = archiveFileName(ctx.name);
  const archivePath = notePath(ctx.root, archiveName);
  const archiveRel = path.relative(ctx.root, archivePath) || archiveName;

  const existing = await readText(archivePath);
  const moved = old.map((section) => section.join('\n').replace(/\s+$/, '')).join('\n\n');
  if (existing === null) {
    await writeFile(
      archivePath,
      `# Archived working notes\n\nSections moved out of ${ctx.rel} once they were older than the\nactive window. Kept for history; not read by the gate.\n\n${moved}\n`,
      'utf8',
    );
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    await appendFile(archivePath, `${sep}${moved}\n`, 'utf8');
  }

  await writeFile(ctx.file, joinNote(header, keep), 'utf8');

  // The archiver has read everything by definition; other working copies get a
  // silent pass because only already-acknowledged sections went away.
  const updated = await readText(ctx.file);
  const branch = await currentBranch(ctx.root);
  await writeAck(ctx.gitDir, ctx.key, updated, { branch, digest: digest(updated), via: 'archive' });

  out(`${BIN_NAME}: moved ${old.length} section${old.length === 1 ? '' : 's'} older than ${cutoff} into ${archiveRel}.`);
  out(`  ${ctx.rel} now holds ${keep.length} active section${keep.length === 1 ? '' : 's'}.`);
  out(`  Commit both files together. Other working copies pass silently:`);
  out(`  they had already acknowledged everything that moved.`);
  return 0;
}

/* ----------------------------------------------------------------- init --- */

const WIRING_SNIPPET = (rel) => `<!-- ${BIN_NAME} -->
This repository may be worked on by more than one session at a time.
Before you commit or push, run:

    npx ${BIN_NAME} check

It exits non-zero until ${rel} has been read in this working
copy, and prints only what is new since your last read.

When you change something another session could trip over, say so:

    npx ${BIN_NAME} note "rewriting src/db/schema.ts wholesale — do not hand-edit"
`;

async function confirm(question) {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function init(opts = {}) {
  const ctx = await context(opts);
  if (!requireRepo(ctx)) return 2;

  const had = await exists(ctx.file);
  if (had) {
    out(`${BIN_NAME}: ${ctx.rel} already exists — left untouched.`);
  } else {
    await writeFile(ctx.file, NOTE_HEADER, 'utf8');
    out(`${BIN_NAME}: created ${ctx.rel}.`);
  }

  // Whoever ran init has, by definition, seen what init just wrote.
  const content = await readText(ctx.file);
  const branch = await currentBranch(ctx.root);
  if (content !== null) await writeAck(ctx.gitDir, ctx.key, content, { branch });

  out('');
  out(`1. Put the gate inside a command nobody can skip. In package.json:`);
  out('');
  out(`     "scripts": { "test": "${BIN_NAME} check && <your existing test command>" }`);
  out('');
  out(`   And in CI, where it cannot be skipped at all:`);
  out('');
  out(`     - run: npx ${BIN_NAME} verify --base origin/\${{ github.base_ref }}`);
  out('');
  out(`2. Tell every session it exists. Paste into your contributor and agent`);
  out(`   instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) and the README:`);
  out('');
  for (const line of splitLines(WIRING_SNIPPET(ctx.rel))) out(`     ${line}`);
  out('');
  out(`3. Commit ${ctx.rel} so the note arrives on the same pull as the code.`);
  out('');

  let wantsHook = opts.hook === true ? true : opts.hook === false ? false : null;
  if (wantsHook === null) {
    wantsHook = await confirm(`Install the pre-push and prepare-commit-msg hooks now? [Y/n] `);
  }

  if (wantsHook === true) {
    await installHookCommand({ ...opts, hook: 'pre-push' });
    await installHookCommand({ ...opts, hook: 'prepare-commit-msg' });
  } else if (wantsHook === null) {
    out(`Then install the hooks (non-interactive here, so run them yourself):`);
    out('');
    out(`    npx ${BIN_NAME} install-hook`);
    out(`    npx ${BIN_NAME} install-hook --hook prepare-commit-msg`);
    out('');
  } else {
    out(`Skipping the hooks. Install them later with:`);
    out(`    npx ${BIN_NAME} install-hook`);
    out(`    npx ${BIN_NAME} install-hook --hook prepare-commit-msg`);
  }
  return 0;
}
