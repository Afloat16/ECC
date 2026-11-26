'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../scripts/hooks/post-edit-console-warn.js');
const { run } = require(SCRIPT);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-console-scan-'));
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++; console.log(`  PASS ${name}`);
  } catch (error) {
    failed++; console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function fixture(content, extension = 'js') {
  const file = path.join(root, `edited.${extension}`);
  fs.writeFileSync(file, content);
  const input = ` { "tool_input": { "file_path": ${JSON.stringify(file)} }, "padding": "unchanged" }\n`;
  return { file, input };
}

function warning(file, lines) {
  return [`[Hook] WARNING: console.log found in ${file}`, ...lines, '[Hook] Remove console.log before committing'].join('\n');
}

function runDirect(input, heapMb) {
  const args = heapMb ? [`--max-old-space-size=${heapMb}`, SCRIPT] : [SCRIPT];
  const result = spawnSync(process.execPath, args, {
    cwd: root, input, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, `hook exited with status ${result.status}, signal ${result.signal}`);
  assert.strictEqual(result.stdout, input);
  return result;
}

try {
  test('preserves first-five warning text and LF line numbers across CRLF and Unicode', () => {
    const { file, input } = fixture([
      '\uFEFFconsole.log("first");',
      'const ordinary = 1;',
      ' \tconsole.log("second"); \t',
      'console.log("third");\r console.log("same physical line");',
      '// \u{1F600} console.log("fourth");\u2028suffix',
      '\tconsole.log("fifth");',
      'console.log("sixth");',
    ].join('\r\n'));
    const expected = warning(file, [
      '1: console.log("first");',
      '3: console.log("second");',
      '4: console.log("third");\r console.log("same physical line");',
      '5: // \u{1F600} console.log("fourth");\u2028suffix',
      '6: console.log("fifth");',
    ]);
    assert.deepStrictEqual(run(input), { stdout: input, stderr: expected, exitCode: 0 });
    assert.strictEqual(runDirect(input).stderr, `${expected}\n`);
  });

  test('finds a final warning after blank lines without a trailing newline', () => {
    const { file, input } = fixture('\n\nconst value = 1;\n  console.log(value);  ');
    assert.strictEqual(run(input).stderr, warning(file, ['4: console.log(value);']));
  });

  for (const extension of ['js', 'jsx', 'ts', 'tsx']) {
    test(`preserves warnings for .${extension} edits`, () => {
      const { file, input } = fixture('console.log("debug");\n', extension);
      assert.strictEqual(runDirect(input).stderr, `${warning(file, ['1: console.log("debug");'])}\n`);
    });
  }

  test('keeps unsupported extensions and absent, empty or missing files quiet', () => {
    for (const extension of ['txt', 'mts', 'mjs', 'JS']) {
      assert.strictEqual(run(fixture('console.log("ignored");', extension).input).stderr, '');
    }
    assert.strictEqual(run(fixture('').input).stderr, '');
    const missing = JSON.stringify({ tool_input: { file_path: path.join(root, 'missing.js') } });
    for (const input of [missing, '{}', '{invalid', 'null']) {
      assert.deepStrictEqual(run(input), { stdout: input, stderr: '', exitCode: 0 });
    }
  });

  test('scans a million-line source file within a 64 MiB heap without warnings', () => {
    const { input } = fixture('// filler\n'.repeat(1000000));
    assert.strictEqual(runDirect(input, 64).stderr, '');
  });

  test('reports the first five warnings within a 64 MiB heap despite a million-line tail', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `console.log(${i});`);
    const { file, input } = fixture(`${lines.join('\n')}\n${'// filler\n'.repeat(1000000)}`);
    const expected = warning(file, [
      '1: console.log(0);', '2: console.log(1);', '3: console.log(2);', '4: console.log(3);', '5: console.log(4);',
    ]);
    assert.strictEqual(runDirect(input, 64).stderr, `${expected}\n`);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
