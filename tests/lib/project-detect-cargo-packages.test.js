'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { detectProjectType, getRustDeps } = require('../../scripts/lib/project-detect');

function withCargo(contents, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cargo-packages-'));
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    if (contents !== null) fs.writeFileSync(path.join(project, 'Cargo.toml'), contents);
    check(project, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const section of ['dependencies', 'dev-dependencies']) {
  for (const syntax of ['inline', 'table']) {
    test(`${section} ${syntax} uses package identity instead of the local alias`, () => {
      const content = syntax === 'inline'
        ? `[${section}]\nweb = { package = 'axum', version = '0.8' }\n`
        : `[${section}.web]\npackage = 'axum'\nversion = '0.8'\n`;
      withCargo(content, project => {
        assert.deepEqual(getRustDeps(project), ['axum']);
        const detected = detectProjectType(project);
        assert.deepEqual(detected.frameworks, ['axum']);
        assert.equal(detected.primary, 'axum');
      });
    });

    test(`${section} ${syntax} does not treat an alias named axum as the framework`, () => {
      const content = syntax === 'inline'
        ? `[${section}]\naxum = { package = 'serde', version = '1' }\n`
        : `[${section}.axum]\npackage = 'serde'\nversion = '1'\n`;
      withCargo(content, project => {
        assert.deepEqual(getRustDeps(project), ['serde']);
        assert.deepEqual(detectProjectType(project).frameworks, []);
        assert.equal(detectProjectType(project).primary, 'rust');
      });
    });
  }
}

test('keeps ordinary dependencies and reads aliases from git and path declarations', () => {
  withCargo([
    '[dependencies]',
    'serde = "1"',
    'runtime = { version = "1", features = ["full"] }',
    'web = { package = "actix-web", path = "../local-web" }',
    '[dev-dependencies]',
    'web_next = { package = "axum", git = "https://example.test/web.git" }',
  ].join('\n'), project => {
    assert.deepEqual(getRustDeps(project), ['serde', 'runtime', 'actix-web', 'axum']);
    assert.deepEqual(detectProjectType(project).frameworks, ['actix', 'axum']);
  });
});

test('comments and strings containing package text do not change dependency identity', () => {
  withCargo([
    '[dependencies]',
    `ordinary = { version = "1", features = ['package = "axum"'] } # package = "actix-web"`,
    '# web = { package = "axum", version = "0.8" }',
  ].join('\n'), project => {
    assert.deepEqual(getRustDeps(project), ['ordinary']);
    assert.deepEqual(detectProjectType(project).frameworks, []);
  });
});

test('reads quoted keys and escaped package names with CRLF line endings', () => {
  withCargo('[dependencies]\r\n"web-alias" = { package = "a\\u0078um", version = "0.8" }\r\n', project => {
    assert.deepEqual(getRustDeps(project), ['axum']);
    assert.deepEqual(detectProjectType(project).frameworks, ['axum']);
  });
});

test('does not detect dependencies from unrelated metadata or workspace declarations', () => {
  withCargo([
    '[package.metadata.dependencies]',
    'axum = "0.8"',
    '[workspace.dependencies]',
    'web = { package = "actix-web", version = "4" }',
    '[build-dependencies]',
    'axum = "0.8"',
  ].join('\n'), project => {
    assert.deepEqual(getRustDeps(project), []);
    assert.deepEqual(detectProjectType(project).frameworks, []);
  });
});

test('does not guess a framework from a malformed manifest', () => {
  withCargo('[dependencies]\nweb = { package = "axum", version = "0.8"\n', project => {
    assert.deepEqual(getRustDeps(project), []);
    assert.equal(detectProjectType(project).primary, 'rust');
  });
});

test('ignores invalid dependency shapes and non-string package fields', () => {
  withCargo('[dependencies]\naxum = { package = 123 }\nweb = false\nother = []\n', project => {
    assert.deepEqual(getRustDeps(project), []);
    assert.deepEqual(detectProjectType(project).frameworks, []);
  });
});

test('handles a missing manifest without loading a parser', () => {
  withCargo(null, project => assert.deepEqual(getRustDeps(project), []));
});

test('preserves simple dependency detection when the optional parser is unavailable', () => {
  const originalLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === '@iarna/toml') {
      const error = new Error("Cannot find module '@iarna/toml'");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return Reflect.apply(originalLoad, this, [request, ...args]);
  };
  try {
    withCargo('[dependencies]\naxum = "0.8"\n[dev-dependencies]\nserde = "1"\n', project => {
      assert.deepEqual(getRustDeps(project), ['axum', 'serde']);
      assert.equal(detectProjectType(project).primary, 'axum');
    });
  } finally {
    Module._load = originalLoad;
  }
});

for (const [alias, actualPackage, expectedFrameworks] of [
  ['web', 'axum', ['axum']],
  ['axum', 'serde', []],
]) {
  test(`SessionStart reports the package ${actualPackage} behind alias ${alias}`, () => {
    withCargo(`[dependencies]\n${alias} = { package = '${actualPackage}', version = '1' }\n`, (project, root) => {
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/hooks/session-start.js')], {
        cwd: project,
        input: JSON.stringify({ source: 'startup' }),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
          ECC_SESSION_RETENTION_DAYS: 'off',
          ECC_SESSION_START_CONTEXT: 'on',
          ECC_SESSION_START_MAX_CHARS: '12000',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(payload.hookEventName, 'SessionStart');
      const line = payload.additionalContext.split('\n').find(value => value.startsWith('Project type: '));
      assert.ok(line, result.stdout);
      const detected = JSON.parse(line.slice('Project type: '.length));
      assert.deepEqual(detected.frameworks, expectedFrameworks);
      assert.equal(detected.primary, expectedFrameworks[0] || 'rust');
      assert.equal(fs.readFileSync(path.join(project, 'Cargo.toml'), 'utf8'),
        `[dependencies]\n${alias} = { package = '${actualPackage}', version = '1' }\n`);
    });
  });
}
