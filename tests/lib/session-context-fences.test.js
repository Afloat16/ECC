'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { parseSessionMetadata, getSessionStats } = require('../../scripts/lib/session-manager');
const { createClaudeHistoryAdapter } = require('../../scripts/lib/session-adapters/claude-history');

function session(body, options = {}) {
  const { eol = '\n', open = '```', close = '```', heading = '### Context to Load' } = options;
  return ['# Continue implementation', '', heading, open, ...body, close, ''].join(eol);
}

const cases = [
  { name: 'ordinary LF block', content: session(['src/a.js', 'docs/plan.md']), expected: 'src/a.js\ndocs/plan.md' },
  { name: 'CRLF block', content: session(['src/a.js', 'docs/plan.md'], { eol: '\r\n' }), expected: 'src/a.js\r\ndocs/plan.md' },
  { name: 'backtick info string', content: session(['src/a.js'], { open: '```text' }), expected: 'src/a.js' },
  { name: 'tilde fence', content: session(['src/a.js'], { open: '~~~text', close: '~~~' }), expected: 'src/a.js' },
  { name: 'longer opening fence', content: session(['src/a.js'], { open: '````', close: '````' }), expected: 'src/a.js' },
  { name: 'longer closing fence', content: session(['src/a.js'], { close: '`````' }), expected: 'src/a.js' },
  { name: 'inline backticks in a path', content: session(['docs/notes```draft.md', 'src/a.js']), expected: 'docs/notes```draft.md\nsrc/a.js' },
  { name: 'shorter fence stays in the body', content: session(['src/a.js', '```', 'docs/plan.md'], { open: '````', close: '````' }), expected: 'src/a.js\n```\ndocs/plan.md' },
  { name: 'other fence marker stays in the body', content: session(['src/a.js', '~~~', 'docs/plan.md']), expected: 'src/a.js\n~~~\ndocs/plan.md' },
  { name: 'text after fence is body content', content: session(['src/a.js', '```suffix', 'docs/plan.md']), expected: 'src/a.js\n```suffix\ndocs/plan.md' },
  { name: 'four-space fence is body content', content: session(['src/a.js', '    ```', 'docs/plan.md']), expected: 'src/a.js\n    ```\ndocs/plan.md' },
  { name: 'indented top-level block', content: session(['  src/a.js', '   docs/plan.md'], { heading: '   ### Context to Load', open: '  ```', close: ' ```  \t' }), expected: 'src/a.js\n docs/plan.md' },
  { name: 'missing closing fence remains absent', content: '# Session\n### Context to Load\n```\nsrc/a.js\n', expected: '' },
  { name: 'mismatched closing marker remains absent', content: session(['src/a.js'], { close: '~~~' }), expected: '' },
  { name: 'empty block remains empty', content: session([]), expected: '' },
  { name: 'next section cannot supply its code block', content: '# Session\n### Context to Load\n\n## Other\n```\nwrong.js\n```\n', expected: '' },
  { name: 'blank lines before opening fence', content: '# Session\n### Context to Load\n \t\n\n```\nsrc/a.js\n```', expected: 'src/a.js' },
  { name: 'backtick in info string is not a fence', content: session(['src/a.js'], { open: '```invalid`info' }), expected: '' },
  { name: 'inline section label is not a heading', content: 'Example ### Context to Load\n```\nwrong.js\n```', expected: '' },
  { name: 'fenced example cannot override the real section', content: [
    '# Session', '### Notes for Next Session', '````markdown', '### Context to Load',
    '```', 'example.js', '```', '````', '', '### Context to Load', '```', 'src/real.js', '```'
  ].join('\n'), expected: 'src/real.js' }
];

for (const entry of cases) {
  test('context framing: ' + entry.name, () => {
    const metadata = parseSessionMetadata(entry.content);
    assert.equal(metadata.context, entry.expected);
    assert.equal(getSessionStats(entry.content).hasContext, Boolean(entry.expected));
  });
}

for (const entry of [cases[0], cases[1], cases[4], cases[6]]) {
  test('public session inspection preserves paths: ' + entry.name, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-context-fences-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, '2026-11-23-context-session.tmp');
    fs.writeFileSync(file, entry.content);
    const expectedPaths = entry.expected.split(/\r?\n/);
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/session-inspect.js'), file], {
      cwd: root, env: { ...process.env, ECC_AGENT_DATA_HOME: path.join(root, 'agent-data'),
        ECC_SESSION_RECORDING_DIR: path.join(root, 'recordings') }, encoding: 'utf8', timeout: 10000
    });
    assert.equal(child.status, 0, child.stderr);
    const snapshot = JSON.parse(child.stdout);
    assert.deepEqual(snapshot.workers[0].intent.seedPaths, expectedPaths);
    assert.equal(snapshot.workers[0].artifacts.context, entry.expected);
    const recordings = fs.readdirSync(path.join(root, 'recordings', 'claude-history'));
    assert.equal(recordings.length, 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'recordings', 'claude-history', recordings[0]), 'utf8'));
    assert.deepEqual(persisted.latest.workers[0].intent.seedPaths, expectedPaths);
    assert.equal(fs.readFileSync(file, 'utf8'), entry.content);
  });
}

test('injected canonical-session persistence receives the complete context', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-context-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '2026-11-23-writer-session.tmp');
  fs.writeFileSync(file, cases[1].content);
  const writes = [];
  const adapter = createClaudeHistoryAdapter({ stateStore: {
    persistCanonicalSessionSnapshot(snapshot) { writes.push(snapshot); }
  } });
  const snapshot = adapter.open(file, { cwd: root }).getSnapshot();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], snapshot);
  assert.deepEqual(snapshot.workers[0].intent.seedPaths, ['src/a.js', 'docs/plan.md']);
});
