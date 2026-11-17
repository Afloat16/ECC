'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveVaultRoots,
  searchMemories,
  serializeMemoryDocument,
  tokenize,
} = require('../../scripts/lib/memory-vault');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
    failed += 1;
  }
}

function withMemory(overrides, fn) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-memory-unicode-'));
  try {
    fs.mkdirSync(path.join(fixture, '.git'));
    const roots = resolveVaultRoots({ cwd: fixture, homeDir: fixture, env: {} });
    const notes = path.join(roots.project, 'notes');
    fs.mkdirSync(notes, { recursive: true });
    const document = serializeMemoryDocument({
      schema: 'ecc.memory.v1', id: 'mem_unicode_example', title: 'Neutral', kind: 'note',
      scope: 'project', trust: 'unreviewed', status: 'active', sourceHarness: 'claude',
      targetHarnesses: ['all'], tags: [], links: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      body: 'Separate context.', ...overrides,
    });
    const file = path.join(notes, 'memory.md');
    fs.writeFileSync(file, document);
    fn(query => searchMemories(query, { roots, scopes: ['project'] }));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), document, 'search must not rewrite stored text');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

test('tokenization keeps combining marks with their letters', () => {
  assert.deepStrictEqual(tokenize('Cafe\u0301 কো ক্ষমা दिन'), ['café', 'কো', 'ক্ষমা', 'दिन']);
});

for (const text of ['Café', 'Ångström', 'কো', '한글']) {
  for (const [storedForm, queryForm] of [['NFC', 'NFD'], ['NFD', 'NFC']]) {
    test(`canonical ${storedForm} title matches ${queryForm} query: ${text}`, () => {
      const title = text.normalize(storedForm);
      withMemory({ title }, search => {
        const results = search(text.normalize(queryForm)).results;
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].score, 28);
        assert.strictEqual(results[0].memory.title, title, 'returned metadata keeps its original spelling');
      });
    });
  }
}

test('body phrase and occurrence scoring uses the same canonical form', () => {
  withMemory({ body: 'Café and CAFE\u0301.' }, search => {
    const results = search('cafe\u0301').results;
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].score, 7);
  });
});

for (const [title, query] of [['জল', 'জাল'], ['दान', 'दिन']]) {
  test(`vowel marks do not split ${query} into unrelated consonant matches`, () => {
    withMemory({ title }, search => assert.deepStrictEqual(search(query).results, []));
  });
}

test('a complete conjunct word contributes one title token', () => {
  withMemory({ title: 'ক্ষমা' }, search => {
    assert.strictEqual(search('ক্ষমা').results[0].score, 28);
  });
});

test('canonically equivalent query tokens are counted only once', () => {
  withMemory({ title: 'Café' }, search => {
    assert.strictEqual(search('café cafe\u0301').results[0].score, 8);
  });
});

test('excerpt positions use the normalized display text after a decomposed prefix', () => {
  const body = `${'e\u0301 '.repeat(150)}Cafe\u0301 ${'tail '.repeat(80)}`;
  withMemory({ title: 'Cafe\u0301', body }, search => {
    const result = search('CAFÉ').results[0];
    assert.ok(result);
    assert.strictEqual(result.excerpt, `…${'é '.repeat(30)}Café ${'tail '.repeat(35)}…`);
    assert.strictEqual(result.memory.title, 'Cafe\u0301');
    assert.ok(!Object.hasOwn(result.memory, 'body'));
  });
});

test('normalization preserves accent and compatibility distinctions', () => {
  withMemory({ title: 'Café ①' }, search => {
    assert.deepStrictEqual(search('cafe').results, []);
    assert.deepStrictEqual(search('1').results, []);
  });
});

test('ASCII case, identifier, digit and punctuation token rules stay compatible', () => {
  assert.deepStrictEqual(tokenize('API foo_bar release-2 (42)!'), ['api', 'foo_bar', 'release-2', '42']);
  assert.deepStrictEqual(tokenize(null), []);
  assert.deepStrictEqual(tokenize('\u0301'), []);
  withMemory({ title: 'API release-2' }, search => {
    assert.strictEqual(search('api').results[0].score, 28);
    assert.strictEqual(search('').results[0].score, 0);
  });
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
