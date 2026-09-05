/**
 * pairwarn subcommands. Each returns a process exit code:
 *   0 = fine, 1 = refused (unread notes), 2 = usage error.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BIN_NAME,
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
  if (acked === current) return 0;

  const added = newLines(acked ?? '', current);
  const first = acked === null;

  err('');
  err(`${BIN_NAME}: refusing — ${ctx.rel} has not been read in this working copy.`);
  err('');
  if (first) {
    err(`This is a fresh reader. Another session may have left something here`);
    err(`that you are about to walk straight into.`);
  } else {
    const when = info?.ackedAt ? info.ackedAt.slice(0, 19).replace('T', ' ') : 'your last read';
    err(`${ctx.rel} changed since ${when} UTC.`);
  }
  err('');

  if (added.length === 0) {
    err(`  (lines were removed or rewritten above; nothing was appended)`);
    err(`  Open ${ctx.rel} and read it.`);
  } else {
    err(`${added.length} new line${added.length === 1 ? '' : 's'} in ${ctx.rel}:`);
    err('  ' + '-'.repeat(68));
    for (const line of added.slice(0, MAX_PRINTED_LINES)) err(`  | ${line}`);
    if (added.length > MAX_PRINTED_LINES) {
      err(`  | ... ${added.length - MAX_PRINTED_LINES} more lines — open ${ctx.rel}`);
    }
    err('  ' + '-'.repeat(68));
  }

  err('');
  err(`Read the above, then record it:`);
  err('');
  err(`    npx ${BIN_NAME} ack`);
  err('');
  err(`The record lives in .git/ and is never committed, so it is yours alone:`);
  err(`nobody can acknowledge on your behalf, and a fresh clone reads again.`);
  err('');
  return 1;
}

/* ------------------------------------------------------------------ ack --- */

export async function ack(opts = {}) {
  const ctx = await context(opts);
  if (!requireRepo(ctx)) return 2;

  const current = await readText(ctx.file);
  if (current === null) {
    out(`${BIN_NAME}: ${ctx.rel} does not exist — nothing to acknowledge.`);
    return 0;
  }

  const branch = await currentBranch(ctx.root);
  const { snapshot } = await writeAck(ctx.gitDir, ctx.key, current, { branch });
  const n = splitLines(current).length;
  out(`${BIN_NAME}: acknowledged ${ctx.rel} (${n} line${n === 1 ? '' : 's'}).`);
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
  await writeAck(ctx.gitDir, ctx.key, updated, { branch });

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
  out(`2. Tell every session it exists. Paste into your contributor and agent`);
  out(`   instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) and the README:`);
  out('');
  for (const line of splitLines(WIRING_SNIPPET(ctx.rel))) out(`     ${line}`);
  out('');
  out(`3. Commit ${ctx.rel} so the note arrives on the same pull as the code.`);
  out('');

  let wantsHook = opts.hook === true ? true : opts.hook === false ? false : null;
  if (wantsHook === null) {
    wantsHook = await confirm(`Install the pre-push hook now? [Y/n] `);
  }

  if (wantsHook === true) {
    await installHookCommand({ ...opts, hook: 'pre-push' });
  } else if (wantsHook === null) {
    out(`Then install the hook (non-interactive here, so run it yourself):`);
    out('');
    out(`    npx ${BIN_NAME} install-hook`);
    out('');
  } else {
    out(`Skipping the hook. Install it later with: npx ${BIN_NAME} install-hook`);
  }
  return 0;
}
