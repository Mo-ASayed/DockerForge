# Programmatic API

`@dockerforge/core` is the engine the CLI is built on. Use it when you want to generate or lint
from your own Node code. It is offline and makes no network calls.

```bash
npm install @dockerforge/core
```

```js
const core = require('@dockerforge/core');
```

## ingestLocal(targetPath)

Resolve and validate a project directory. Returns the absolute path. Throws a typed error if the
path is missing or is not a directory.

```js
const projectPath = await core.ingestLocal('./my-app');
```

## runDockerfileEngine(input)

Run the generation pipeline against a local project.

```js
const result = await core.runDockerfileEngine({
  projectPath,          // required
  hints: { stack: 'node', port: 3000 },  // optional
  optimise: true,       // optional, default true
  security: true,       // optional, default true
});
```

| Field | Type | Notes |
| --- | --- | --- |
| `projectPath` | string | Required. Absolute or relative path to the project. |
| `hints` | object | Optional. Override detection, for example `{ stack, port }`. |
| `optimise` | boolean | Optional. Set `false` to skip the optimisation pass. |
| `security` | boolean | Optional. Set `false` to skip the security pass. |

The result:

| Field | Type | Notes |
| --- | --- | --- |
| `dockerfile` | string | The generated Dockerfile. |
| `dockerignore` | string | The generated `.dockerignore`. |
| `compose` | string | The generated Compose file. |
| `confidence` | number | Between 0 and 1. |
| `improvements` | string[] | Suggested changes and warnings. |

`projectPath` is required. Passing remote-only input such as a git URL throws an `IngestError`,
because remote ingestion is part of the hosted product, not this package.

```js
const { dockerfile, confidence } = await core.runDockerfileEngine({ projectPath });
```

## lint(target, options)

Lint a Dockerfile. `target` is a path to a Dockerfile, a path to a directory that contains one, or
an object `{ dockerfile: string }` to lint text directly.

```js
const { findings, summary } = await core.lint('./Dockerfile');
const fromString = await core.lint({ dockerfile: 'FROM node\nUSER root\n' });
```

Options:

| Field | Type | Notes |
| --- | --- | --- |
| `rules` | string[] | Optional. Rule ids to run. Defaults to all. |

Each finding:

| Field | Type | Notes |
| --- | --- | --- |
| `ruleId` | string | For example `DF001`. |
| `severity` | string | `info`, `low`, `medium`, `high`, or `critical`. |
| `message` | string | What was found. |
| `line` | number | The Dockerfile line, when one applies. |

The summary:

| Field | Type | Notes |
| --- | --- | --- |
| `counts` | object | Count per severity. |
| `worst` | string \| null | The highest severity found, or `null` for a clean file. |

The rules themselves are documented in [rules.md](rules.md). To render SARIF, use the CLI
(`dockerforge lint --format sarif`), which wraps these findings in SARIF 2.1.0.

## Errors

Every error carries a string `code`, so you can branch without matching on messages.

| Class | `code` |
| --- | --- |
| `PathNotFoundError` | `PATH_NOT_FOUND` |
| `NotADirectoryError` | `NOT_A_DIRECTORY` |
| `UnsupportedStackError` | `UNSUPPORTED_STACK` |
| `IngestError` | `INGEST_ERROR` |
| `DockerForgeError` | base class |

```js
try {
  await core.ingestLocal('./does-not-exist');
} catch (err) {
  if (err.code === 'PATH_NOT_FOUND') {
    // handle a missing path
  }
}
```

All error classes are exported from the package root:

```js
const { PathNotFoundError, DockerForgeError } = require('@dockerforge/core');
```
