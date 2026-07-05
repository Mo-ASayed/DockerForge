'use strict';

// Graceful handling of unsupported languages.
//
// When a project is not one of the supported stacks (Node, Python, .NET, Go, Rust), the engine
// must fail with a typed UnsupportedStackError (code UNSUPPORTED_STACK) and a helpful message —
// never a bare crash. When the language is recognised (Ruby/Java/PHP/...), the message names it.
//
// Run host-side: `node --test test/unsupported.test.js` from packages/core.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const core = require('../src/index.js');
const FIX = path.join(__dirname, 'unsupported-fixtures');

async function expectUnsupported(fixture) {
  const projectPath = await core.ingestLocal(path.join(FIX, fixture));
  await assert.rejects(
    () => core.runDockerfileEngine({ projectPath }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_STACK', `${fixture}: should be a typed UNSUPPORTED_STACK error`);
      assert.match(err.message, /Node\.js, Python, \.NET, Go, and Rust/, `${fixture}: lists the supported stacks`);
      return true;
    }
  );
  return projectPath;
}

test('Ruby project fails gracefully and is named', async () => {
  const projectPath = await core.ingestLocal(path.join(FIX, 'ruby'));
  await assert.rejects(
    () => core.runDockerfileEngine({ projectPath }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_STACK');
      assert.match(err.message, /Ruby/, 'names Ruby');
      return true;
    }
  );
});

test('Java project fails gracefully and is named', async () => {
  const projectPath = await core.ingestLocal(path.join(FIX, 'java'));
  await assert.rejects(
    () => core.runDockerfileEngine({ projectPath }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_STACK');
      assert.match(err.message, /Java/, 'names Java');
      return true;
    }
  );
});

test('PHP project fails gracefully and is named', async () => {
  const projectPath = await core.ingestLocal(path.join(FIX, 'php'));
  await assert.rejects(
    () => core.runDockerfileEngine({ projectPath }),
    (err) => {
      assert.equal(err.code, 'UNSUPPORTED_STACK');
      assert.match(err.message, /PHP/, 'names PHP');
      return true;
    }
  );
});

test('A project with no recognised stack gives a clear generic message', async () => {
  await expectUnsupported('unknown');
});
