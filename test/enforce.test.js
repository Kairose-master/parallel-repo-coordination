/**
 * The enforcement layer: what stops someone who does not want to be stopped.
 *
 * A local hook is a courtesy — `--no-verify` skips it and anyone can delete it.
 * These tests cover the parts that survive that: the commit trailer, the CI
 * audit that reads it, the token that makes a blind ack impossible, and the
 * archive that keeps the note short enough to actually be read.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

import { ackToken, binShim, CLI, cleanup, commitAll, git, readAndAck, run, tempDir, tempRepo } from './helpers.js';

after(cleanup);

const NOTE = 'conversation.md';
const WARNING = '## 2026-01-02 — feat/payments\n\nMigration 0042 is half-applied on staging.\n';

/** Commit without going through the hooks, the way a bypass actually happens. */
function rawCommit(cwd, message, { args = [], env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['commit', '-q', ...args, '-m', message],
      { cwd, encoding: 'utf8', env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }),
    );
  });
}

async function repoWithHooks() {
  const scratch = await tempDir();
  const dir = await tempRepo();
  const env = { PAIRWARN_BIN: await binShim(scratch) };
  await run(dir, ['init', '--yes'], { env });
  return { dir, env };
}

describe('ack token — a blind ack is not possible', () => {
  it('refuses a bare ack while there is unread content', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING, 'utf8');

    const { code, stderr } = await run(dir, ['ack']);
    assert.equal(code, 1);
    assert.match(stderr, /acknowledge them by token/);
    assert.equal((await run(dir, ['check'])).code, 1, 'the gate is still closed');
  });

  it('refuses a token that does not match the current note', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING, 'utf8');

    const { code, stderr } = await run(dir, ['ack', 'deadbeefcafe']);
    assert.equal(code, 1);
    assert.match(stderr, /does not match/);
    assert.equal((await run(dir, ['check'])).code, 1);
  });

  it('accepts the token printed by check, and only after the text', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING, 'utf8');

    const { stderr } = await run(dir, ['check']);
    const shown = stderr.indexOf('Migration 0042');
    const token = /ack ([0-9a-f]{12})/.exec(stderr);
    assert.ok(token, 'check prints a token');
    assert.ok(shown !== -1 && shown < stderr.indexOf(token[0]), 'the note text comes before the token');

    assert.equal((await run(dir, ['ack', token[1]])).code, 0);
    assert.equal((await run(dir, ['check'])).code, 0);
  });

  it('lets a bare ack through when there is nothing unread', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING, 'utf8');
    await readAndAck(dir);
    assert.equal((await run(dir, ['ack'])).code, 0, 'ack stays idempotent');
  });
});

describe('commit trailer', () => {
  it('stamps commits through the prepare-commit-msg hook', async () => {
    const { dir, env } = await repoWithHooks();
    await run(dir, ['note', 'Do not hand-edit schema.ts'], { env });
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'initial', { env });

    const message = await git(dir, ['log', '-1', '--format=%B']);
    assert.match(message, /^Note-Ack: [0-9a-f]{12}$/m);
    assert.match(message, /^initial$/m, 'the original subject survives');
  });

  it('refuses to stamp an unread note, which aborts the commit', async () => {
    const { dir, env } = await repoWithHooks();
    await writeFile(path.join(dir, NOTE), WARNING, 'utf8');
    await git(dir, ['add', '-A']);

    const attempt = await rawCommit(dir, 'sneaking past', { env });
    assert.notEqual(attempt.code, 0, 'the commit is aborted');
    assert.match(attempt.stderr, /refusing to stamp/);
  });

  it('replaces a stale trailer rather than stacking a second one', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING, 'utf8');
    await readAndAck(dir);

    const msgFile = path.join(dir, 'MSG');
    await writeFile(msgFile, 'subject\n\nNote-Ack: 000000000000\n', 'utf8');
    assert.equal((await run(dir, ['stamp', '--commit-msg', msgFile])).code, 0);

    const written = await readFile(msgFile, 'utf8');
    assert.equal(written.match(/Note-Ack:/g).length, 1);
    assert.doesNotMatch(written, /000000000000/);
  });
});

describe('verify — the part that cannot be bypassed from a working copy', () => {
  it('passes when every commit acknowledged the note', async () => {
    const { dir, env } = await repoWithHooks();
    await run(dir, ['note', 'Base rule'], { env });
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'first', { env });
    const base = await git(dir, ['rev-parse', 'HEAD']);

    await writeFile(path.join(dir, 'b.txt'), 'y\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'second', { env });

    const { code, stdout } = await run(dir, ['verify', '--base', base], { env });
    assert.equal(code, 0);
    assert.match(stdout, /1 commit verified/);
  });

  it('is not bypassed by --no-verify alone: prepare-commit-msg still runs', async () => {
    const { dir, env } = await repoWithHooks();
    await run(dir, ['note', 'Base rule'], { env });
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'first', { env });

    await appendFile(path.join(dir, NOTE), '\n## 2026-01-03 — other\n\nUnread warning.\n', 'utf8');
    await git(dir, ['add', '-A']);
    const attempt = await rawCommit(dir, 'sneaking past', { args: ['--no-verify'], env });

    assert.notEqual(attempt.code, 0, 'git --no-verify does not skip prepare-commit-msg');
    assert.match(attempt.stderr, /refusing to stamp/);
    assert.equal(await git(dir, ['log', '-1', '--format=%s']), 'first', 'no commit was made');
  });

  it('catches commits made after the hooks were deleted outright', async () => {
    const { dir, env } = await repoWithHooks();
    await run(dir, ['note', 'Base rule'], { env });
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'first', { env });
    const base = await git(dir, ['rev-parse', 'HEAD']);

    // The bypass that actually works: remove the hooks, then commit freely.
    await rm(path.join(dir, '.git', 'hooks', 'prepare-commit-msg'));
    await rm(path.join(dir, '.git', 'hooks', 'pre-push'));
    await appendFile(path.join(dir, NOTE), '\n## 2026-01-03 — sneaky\n\nQuietly changed the auth flow.\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'bypassed', { env });

    const { code, stderr } = await run(dir, ['verify', '--base', base], { env });
    assert.equal(code, 1);
    assert.match(stderr, /did not acknowledge/);
    assert.match(stderr, /no Note-Ack trailer/);
    assert.match(stderr, /bypassed/);
  });

  it('catches a stale trailer forged against an older note', async () => {
    const { dir, env } = await repoWithHooks();
    await run(dir, ['note', 'Base rule'], { env });
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'first', { env });
    const base = await git(dir, ['rev-parse', 'HEAD']);
    const stale = /Note-Ack: ([0-9a-f]{12})/.exec(await git(dir, ['log', '-1', '--format=%B']))[1];

    await rm(path.join(dir, '.git', 'hooks', 'prepare-commit-msg'));
    await appendFile(path.join(dir, NOTE), '\n## 2026-01-03 — other\n\nNew warning.\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, `forged\n\nNote-Ack: ${stale}`, { env });

    const { code, stderr } = await run(dir, ['verify', '--base', base], { env });
    assert.equal(code, 1);
    assert.match(stderr, /stale — the note changed/);
  });

  it('ignores commits from before the note file existed', async () => {
    const { dir, env } = await repoWithHooks();
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await rm(path.join(dir, '.git', 'hooks', 'prepare-commit-msg'));
    await writeFile(path.join(dir, '.gitignore'), `${NOTE}\n`, 'utf8');
    await git(dir, ['add', 'a.txt', '.gitignore']);
    await rawCommit(dir, 'before pairwarn', { env });
    const base = await git(dir, ['rev-parse', 'HEAD']);

    await writeFile(path.join(dir, 'b.txt'), 'y\n', 'utf8');
    await git(dir, ['add', 'b.txt']);
    await rawCommit(dir, 'still before', { env });

    const { code } = await run(dir, ['verify', '--base', base], { env });
    assert.equal(code, 0, 'nothing to prove when the note is not in the tree');
  });

  it('reports a base ref it cannot resolve instead of passing silently', async () => {
    const { dir, env } = await repoWithHooks();
    await writeFile(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    await git(dir, ['add', '-A']);
    await rawCommit(dir, 'first', { env });

    const { code, stderr } = await run(dir, ['verify', '--base', 'origin/nope'], { env });
    assert.equal(code, 2);
    assert.match(stderr, /cannot resolve base ref/);
  });
});

describe('archive — keeping the note short enough to be read', () => {
  const AGED = `
## 2020-01-01 — ancient

Long since irrelevant.

## 2020-06-01 — old

Also stale.

## 2999-01-01 — future

Still matters.
`;

  it('moves only sections older than the cutoff', async () => {
    const dir = await tempRepo();
    await run(dir, ['init', '--no-hook']);
    await appendFile(path.join(dir, NOTE), AGED, 'utf8');
    await readAndAck(dir);

    const { code, stdout } = await run(dir, ['archive', '--older-than', '30']);
    assert.equal(code, 0);
    assert.match(stdout, /moved 2 sections/);

    const active = await readFile(path.join(dir, NOTE), 'utf8');
    assert.doesNotMatch(active, /Long since irrelevant/);
    assert.match(active, /Still matters/);
    assert.match(active, /^# Shared working notes$/m, 'the header stays');

    const archived = await readFile(path.join(dir, 'conversation.archive.md'), 'utf8');
    assert.match(archived, /Long since irrelevant/);
    assert.match(archived, /Also stale/);
  });

  it('keeps undated sections rather than guessing at them', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), '## not a date — someone\n\nKeep me.\n', 'utf8');
    await readAndAck(dir);

    const { stdout } = await run(dir, ['archive']);
    assert.match(stdout, /nothing in conversation\.md is older/);
    assert.match(await readFile(path.join(dir, NOTE), 'utf8'), /Keep me\./);
  });

  it('does not force a re-read on working copies that had read the archived sections', async () => {
    const origin = await tempRepo();
    await run(origin, ['init', '--no-hook']);
    await appendFile(path.join(origin, NOTE), AGED, 'utf8');
    await readAndAck(origin);
    await commitAll(origin, 'notes');

    const clones = await tempDir();
    const clone = path.join(clones, 'clone');
    await git(clones, ['clone', '-q', origin, clone]);
    await readAndAck(clone);
    assert.equal((await run(clone, ['check'])).code, 0);

    await run(origin, ['archive', '--older-than', '30']);
    await commitAll(origin, 'archive old notes');
    await git(clone, ['pull', '-q', 'origin', 'main']);

    const { code, stdout, stderr } = await run(clone, ['check']);
    assert.equal(code, 0, 'already-read sections disappearing is not a new warning');
    assert.equal(stdout + stderr, '');
  });

  it('still refuses when an acknowledged section is quietly rewritten', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING, 'utf8');
    await readAndAck(dir);
    await writeFile(path.join(dir, NOTE), '## 2026-01-02 — feat/payments\n\nNothing to see here.\n', 'utf8');

    const { code, stderr } = await run(dir, ['check']);
    assert.equal(code, 1, 'editing a warning out is the failure mode, not the fix');
    assert.match(stderr, /Nothing to see here/);
  });
});

describe('robustness', () => {
  it('survives its output being cut off by a pipe', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING.repeat(50), 'utf8');
    const token = await ackToken(dir);
    assert.ok(token, 'a long refusal still ends with a usable token');
  });

  it('still refuses when the reader stops reading its output', async () => {
    const dir = await tempRepo();
    await writeFile(path.join(dir, NOTE), WARNING.repeat(50), 'utf8');

    // `pairwarn check | head -1` closes the pipe mid-refusal. A gate that
    // answered "fine" to a broken pipe would be worse than no gate at all.
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'check'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.destroy();
      child.stderr.once('data', () => child.stderr.destroy());
      child.on('close', resolve);
    });
    assert.equal(code, 1, 'a truncated refusal is still a refusal');
  });
});
