# @dockerforge/core

The engine behind DockerForge. Generate and lint production-grade Dockerfiles from Node. Offline.

[![npm](https://img.shields.io/npm/v/@dockerforge/core)](https://www.npmjs.com/package/@dockerforge/core)
[![license](https://img.shields.io/npm/l/@dockerforge/core)](https://github.com/Mo-ASayed/DockerForge/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@dockerforge/core)](https://nodejs.org)

Give it a path to a local project and it analyses the stack and returns a Dockerfile, a
`.dockerignore`, and a Compose file, along with a confidence score and suggested improvements. It
also lints existing Dockerfiles. The package makes no network calls; it only reads the local
filesystem under the path you give it.

Most people should use the [`@dockerforge/cli`](https://www.npmjs.com/package/@dockerforge/cli)
command line tool. Use this package when you want to call the engine from your own Node code.

## Install

```bash
npm install @dockerforge/core
```

## Generate

```js
const core = require('@dockerforge/core');

const projectPath = await core.ingestLocal('./my-app');
const result = await core.runDockerfileEngine({ projectPath });

console.log(result.dockerfile);     // the generated Dockerfile
console.log(result.dockerignore);   // the generated .dockerignore
console.log(result.compose);        // the generated Compose file
console.log(result.confidence);     // a number between 0 and 1
console.log(result.improvements);   // suggested changes
```

`runDockerfileEngine` accepts:

| Field | Meaning |
| --- | --- |
| `projectPath` | Required. Absolute or relative path to the project directory. |
| `hints` | Optional stack hints, for example `{ stack: 'node', port: 3000 }`. |
| `optimise` | Set to `false` to skip the optimisation pass. |
| `security` | Set to `false` to skip the security pass. |

`projectPath` is required because this package is offline. Ingesting a remote git URL or a zip is
part of the hosted product, not this package.

## Lint

```js
const { findings, summary } = await core.lint('./Dockerfile');

for (const f of findings) {
  console.log(f.severity, f.ruleId, f.message);
}
console.log(summary.counts); // { critical, high, medium, low, info }
console.log(summary.worst);  // the highest severity found, or null
```

Lint a string instead of a file:

```js
await core.lint({ dockerfile: 'FROM node\nUSER root\n' });
```

The six rules (`DF001`–`DF006`) are documented in the
[rules reference](https://github.com/Mo-ASayed/DockerForge/blob/main/docs/rules.md).

## Errors

The package throws typed errors, each carrying a `.code`: `PathNotFoundError`,
`NotADirectoryError`, `UnsupportedStackError`, `IngestError`, and the base `DockerForgeError`.
They are exported from the package root:

```js
const { PathNotFoundError } = require('@dockerforge/core');
```

See the [programmatic API guide](https://github.com/Mo-ASayed/DockerForge/blob/main/docs/programmatic.md)
for the full surface.

## License

Apache-2.0.
