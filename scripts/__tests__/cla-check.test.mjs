import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  CLA_VERSION,
  decide,
  entryFor,
  EXEMPT_LOGINS,
  guidance,
  readSignatures,
  SIGNATURES_FILE,
} from '../cla-check.mjs';

const madeDirs = [];
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const tempFile = (contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-'));
  madeDirs.push(dir);
  const file = path.join(dir, 'cla-signatures.json');
  fs.writeFileSync(file, contents);
  return file;
};

const signaturesOf = (...logins) => ({
  signatures: logins.map((login) => ({ login, date: '2026-11-11', claVersion: CLA_VERSION })),
});

test('a recorded login is signed', () => {
  const read = readSignatures(tempFile(JSON.stringify(signaturesOf('alice'))));
  assert.equal(read.ok, true);
  assert.deepEqual(decide('alice', read.signatures), { outcome: 'signed', login: 'alice', reason: 'signed 2026-11-11' });
});

test('the login is compared case-insensitively', () => {
  const read = readSignatures(tempFile(JSON.stringify(signaturesOf('alice'))));
  assert.equal(decide('ALICE', read.signatures).outcome, 'signed');
});

test('an unrecorded login is refused, and the message says what to do', () => {
  const read = readSignatures(tempFile(JSON.stringify(signaturesOf('alice'))));
  assert.equal(decide('bob', read.signatures).outcome, 'unsigned');
  const message = guidance('bob');
  assert.match(message, /CLA\.md/);
  assert.match(message, /I have read and agree to the HeoPress CLA\./);
  assert.match(message, /maintainer records the acceptance/);
});

test('bots are skipped rather than refused', () => {
  const read = readSignatures(tempFile(JSON.stringify(signaturesOf('alice'))));
  for (const bot of EXEMPT_LOGINS) assert.equal(decide(bot, read.signatures).outcome, 'skip', bot);
});

test('an empty author is refused, not skipped', () => {
  assert.equal(decide('', []).outcome, 'unsigned');
  assert.equal(decide(undefined, []).outcome, 'unsigned');
});

test('a missing file is a failure, never an empty list that admits everyone', () => {
  const read = readSignatures(path.join(os.tmpdir(), 'definitely-not-there', 'cla-signatures.json'));
  assert.equal(read.ok, false);
  assert.match(read.problems[0], /is missing/);
});

test('a malformed file is a failure', () => {
  const notJson = readSignatures(tempFile('{ nope'));
  assert.equal(notJson.ok, false);
  assert.match(notJson.problems[0], /not JSON/);

  const noArray = readSignatures(tempFile(JSON.stringify({ signatures: 'all' })));
  assert.equal(noArray.ok, false);
  assert.match(noArray.problems[0], /"signatures" array/);
});

test('each entry must name a login, a date and the current CLA version', () => {
  const read = readSignatures(
    tempFile(
      JSON.stringify({
        signatures: [
          { login: '', date: '2026-11-11', claVersion: CLA_VERSION },
          { login: 'alice', date: 'yesterday', claVersion: CLA_VERSION },
          { login: 'bob', date: '2026-11-11', claVersion: '0.9' },
        ],
      }),
    ),
  );
  assert.equal(read.ok, false);
  assert.equal(read.problems.length, 3);
  assert.match(read.problems[0], /has no login/);
  assert.match(read.problems[1], /date must be YYYY-MM-DD/);
  assert.match(read.problems[2], /claVersion must be "1\.0"/);
});

test('the CLI passes a signed author, refuses an unsigned one, and skips a bot', () => {
  const file = tempFile(JSON.stringify(signaturesOf('alice')));
  const run = (author) =>
    execFileSync(process.execPath, ['scripts/cla-check.mjs', '--signatures', file, '--author', author], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  assert.match(run('alice'), /is recorded/);
  assert.match(run('dependabot[bot]'), /skipped/);

  assert.throws(
    () => run('bob'),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /could not find a recorded acceptance/);
      return true;
    },
  );
});

test('--print emits the entry a maintainer adds', () => {
  const entry = JSON.parse(entryFor('Alice', 'Alice A.', '2026-11-11'));
  assert.deepEqual(entry, { login: 'alice', name: 'Alice A.', date: '2026-11-11', claVersion: CLA_VERSION });
});

test('the repository signatures file is valid and names only lowercase logins', () => {
  const read = readSignatures(path.join(process.cwd(), SIGNATURES_FILE));
  assert.equal(read.ok, true, read.problems.join('; '));
  for (const entry of read.signatures) assert.equal(entry.login, entry.login.toLowerCase());
});
