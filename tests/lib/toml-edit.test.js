'use strict';

const assert = require('assert');
const TOML = require('@iarna/toml');
const { findTomlStatements, preservesExistingValues } = require('../../scripts/lib/toml-edit');
const { test } = require('./helpers/mini-test-runner');

const cases = [
  ['empty input has no statements', () => {
    assert.deepStrictEqual(findTomlStatements(''), []);
  }],
  ['quoted and escaped paths retain literal dots, brackets, and equals signs', () => {
    const raw = '  ["mcp_servers" . "chrome\\u002ddevtools"] # [not.a.table]\r\n'
      + '"env.with.dots"."a=]#b" = "value"\r\n'
      + '[["projects"."with.dots"]]\r\n"" = true';
    TOML.parse(raw);
    const statements = findTomlStatements(raw);
    assert.deepStrictEqual(statements.map(({ kind, path }) => [kind, path]), [
      ['table', ['mcp_servers', 'chrome-devtools']],
      ['assignment', ['mcp_servers', 'chrome-devtools', 'env.with.dots', 'a=]#b']],
      ['array-table', ['projects', 'with.dots']],
      ['assignment', ['projects', 'with.dots', '']],
    ]);
    assert.strictEqual(statements.map(({ start, end }) => raw.slice(start, end)).join(''), raw);
  }],
  ['comments, arrays, and nested inline tables cannot create fake statements', () => {
    const raw = '# comment contains "\' [ = {\n\n'
      + 'values = [\n { key = "[features]" }, # quote " and ] in comment\n'
      + ' { key = "a\\"}#", nested = { value = "literal" } },\n]\n'
      + '[features]\ncustom = true # [agents]';
    TOML.parse(raw);
    const statements = findTomlStatements(raw);
    assert.deepStrictEqual(statements.map(({ kind, path }) => [kind, path]), [
      ['trivia', []], ['trivia', []], ['assignment', ['values']],
      ['table', ['features']], ['assignment', ['features', 'custom']],
    ]);
    assert.strictEqual(statements[2].inlineTableEnd, -1);
  }],
  ['inline table ranges ignore braces in strings and trailing comments', () => {
    const raw = '[agents]\n"explorer" = { description = "} # keep", custom = { key = 1 } } # }\n';
    TOML.parse(raw);
    const statement = findTomlStatements(raw)[1];
    assert.deepStrictEqual(statement.path, ['agents', 'explorer']);
    assert.strictEqual(raw.slice(statement.inlineTableEnd), '} # }\n');
  }],
  ['own prototype-like keys remain ordinary TOML keys', () => {
    const raw = '["__proto__"]\n"constructor" = 1\n';
    TOML.parse(raw);
    assert.deepStrictEqual(findTomlStatements(raw)[1].path, ['__proto__', 'constructor']);
  }],
  ['preservation allows added table defaults without changing existing values', () => {
    const raw = 'timestamp = 1979-05-27T07:32:00Z\nlocal = 07:32:00.000\n'
      + 'day = 1979-05-27\namount = 9223372036854775807\nratio = nan\n'
      + 'labels = ["one", "two"]\n[features]\ncustom = true\n';
    const before = TOML.parse(raw);
    const after = TOML.parse(raw + 'multi_agent = true\n');
    assert.strictEqual(preservesExistingValues(before, after), true);
    assert.strictEqual(preservesExistingValues(before, { ...after, labels: ['two', 'one'] }), false);
    assert.strictEqual(preservesExistingValues(before, { ...after, timestamp: new Date(0) }), false);
    assert.strictEqual(preservesExistingValues(before, { ...after, features: {} }), false);
    assert.strictEqual(preservesExistingValues(before, { ...after, features: null }), false);
    assert.strictEqual(preservesExistingValues(before, { ...after, features: [] }), false);
    assert.strictEqual(preservesExistingValues({ key: false }, { key: true }), false);
  }],
];

for (const quote of ['"', "'"]) {
  for (const content of ['', `one ${quote} two ${quote.repeat(2)}\n[features]\n`]) {
    cases.push([`multiline ${quote} strings retain one statement (${content ? 'nonempty' : 'empty'})`, () => {
      const raw = `text = ${quote.repeat(3)}${content}${quote.repeat(3)} # [ignored]\n`
        + '[agents]\nmax_threads = 9\n';
      TOML.parse(raw);
      const statements = findTomlStatements(raw);
      assert.deepStrictEqual(statements.map(({ kind, path }) => [kind, path]), [
        ['assignment', ['text']], ['table', ['agents']], ['assignment', ['agents', 'max_threads']],
      ]);
      assert.strictEqual(statements[1].start, raw.indexOf('[agents]'));
    }]);
  }
}

cases.push(['multiline basic escapes and line continuations retain one source range', () => {
  const raw = 'text = """A \\\n  continuation with \\"quotes\\" and ""\\"\n[features]\n"""\n'
    + '[agents]\nmax_threads = 9\n';
  TOML.parse(raw);
  const statements = findTomlStatements(raw);
  assert.strictEqual(statements.length, 3);
  assert.deepStrictEqual(statements[0].path, ['text']);
  assert.strictEqual(statements[1].start, raw.indexOf('[agents]'));
}]);

const results = cases.map(([name, check]) => test(name, check));
console.log(`\nPassed: ${results.filter(Boolean).length}`);
console.log(`Failed: ${results.filter(result => !result).length}`);
process.exitCode = results.every(Boolean) ? 0 : 1;
