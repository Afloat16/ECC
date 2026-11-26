'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parseSessionMetadata } = require('../../scripts/lib/session-manager');

for (const newline of ['\n', '\r\n']) {
  test(`empty identity fields do not consume the next line (${JSON.stringify(newline)})`, () => {
    const metadata = parseSessionMetadata([
      '# Session', '**Project:**', '**Branch:** \t', '**Worktree:**',
      '### Completed', '- [x] verified a change'
    ].join(newline));
    assert.equal(metadata.project, null);
    assert.equal(metadata.branch, null);
    assert.equal(metadata.worktree, null);
    assert.deepEqual(metadata.completed, ['verified a change']);
  });

  test(`empty time fields do not borrow numeric text from later lines (${JSON.stringify(newline)})`, () => {
    const metadata = parseSessionMetadata([
      '# Session', '**Date:**', '2026-11-26 is a note', '**Started:**',
      '12:34 is a note', '**Last Updated:**', '23:45 is a note'
    ].join(newline));
    assert.equal(metadata.date, null);
    assert.equal(metadata.started, null);
    assert.equal(metadata.lastUpdated, null);
  });

  test(`empty headings do not turn the next line into a title (${JSON.stringify(newline)})`, () => {
    assert.equal(parseSessionMetadata(['# ', '**Project:** example'].join(newline)).title, null);
  });
}

test('populated single-line fields retain spaces, punctuation and tabs', () => {
  const metadata = parseSessionMetadata([
    '# Session overview', '**Date:**\t2026-11-26', '**Started:** 10:20',
    '**Last Updated:**\t11:30', '**Project:** workspace name', '**Branch:** feat/topic',
    '**Worktree:** /workspace/a path'
  ].join('\n'));
  assert.deepEqual({ title: metadata.title, date: metadata.date, started: metadata.started,
    lastUpdated: metadata.lastUpdated, project: metadata.project, branch: metadata.branch,
    worktree: metadata.worktree }, { title: 'Session overview', date: '2026-11-26',
    started: '10:20', lastUpdated: '11:30', project: 'workspace name', branch: 'feat/topic',
    worktree: '/workspace/a path' });
});

test('session-inspect does not publish a following Markdown heading as a worktree', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-metadata-fields-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionPath = path.join(dir, '2026-11-26-fields-session.tmp');
  fs.writeFileSync(sessionPath, '# Session\n**Project:**\n**Branch:**\n**Worktree:**\n### Completed\n- [x] done\n');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/session-inspect.js'), sessionPath], {
    encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir,
      TMPDIR: dir, TMP: dir, TEMP: dir, ECC_STATE_STORE_PATH: path.join(dir, 'state.db') }
  });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.session.repoRoot, null);
  assert.equal(snapshot.workers[0].branch, null);
  assert.equal(snapshot.workers[0].worktree, null);
});
