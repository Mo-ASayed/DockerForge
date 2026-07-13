# DockerForge

Generate secure, review-ready Dockerfiles and lint existing Docker configurations.

[![npm cli](https://img.shields.io/npm/v/@dockerforge/cli?label=%40dockerforge%2Fcli)](https://www.npmjs.com/package/@dockerforge/cli)
[![npm core](https://img.shields.io/npm/v/@dockerforge/core?label=%40dockerforge%2Fcore)](https://www.npmjs.com/package/@dockerforge/core)
[![release](https://img.shields.io/github/v/release/Mo-ASayed/DockerForge?label=release)](https://github.com/Mo-ASayed/DockerForge/releases)
[![license](https://img.shields.io/npm/l/@dockerforge/cli)](LICENSE)
[![node](https://img.shields.io/node/v/@dockerforge/cli)](https://nodejs.org)
[![stars](https://img.shields.io/github/stars/Mo-ASayed/DockerForge?style=social)](https://github.com/Mo-ASayed/DockerForge/stargazers)

Point DockerForge at a project and it detects the stack, then writes a Dockerfile, a `.dockerignore`, and a Compose file. It also lints existing Dockerfiles and reports findings as human text, JSON, or SARIF.

If DockerForge saves you time or catches a Dockerfile issue, please star the repo. It helps other developers find it.

## Why DockerForge

- Useful Dockerfiles in one command, not a blank template.
- Sensible defaults: multi-stage builds, non-root runtime users, healthchecks, pinned base image tags, and focused `.dockerignore` files.
- Offline by default. The only networked generation option is the explicit `--pin-digests` flag.
- CI friendly linting with SARIF output for GitHub code scanning.
- Small npm packages with a CLI for users and a core engine for Node integrations.

## Quick start

Run it directly with npx:

```bash
npx @dockerforge/cli generate ./my-app
```

Or install the CLI globally:

```bash
npm install -g @dockerforge/cli
dockerforge generate ./my-app
```

Example output:

```text
DockerForge
  Services   1 found [.(node)]
  Confidence High (0.94)
  Warnings   3

  written  ./my-app/Dockerfile
  written  ./my-app/.dockerignore
  written  ./my-app/docker-compose.yml

  Review before shipping:
   - HEALTHCHECK probes /health; add a /health endpoint if your app does not expose one
```

## Generate a Dockerfile

Run DockerForge from the root of the app you want to containerise:

```bash
cd ./my-app
npx @dockerforge/cli generate .
```

DockerForge requires an explicit subcommand. A bare `dockerforge` command prints help and does
not write files.

DockerForge writes:

```text
Dockerfile
.dockerignore
docker-compose.yml
```

Preview the Dockerfile before writing files:

```bash
npx @dockerforge/cli generate ./my-app --print
```

Pin Docker Hub base images to immutable SHA-256 digests:

```bash
npx @dockerforge/cli generate ./my-app --pin-digests
```

Default generation is offline. `--pin-digests` makes live Docker Hub registry requests, then writes base images like `node:20-alpine3.21@sha256:...`. Digest-pinned images stay fixed until you update them, so use Docker Scout, Renovate, Dependabot, or a similar process to refresh base-image digests.

Write generated files somewhere else:

```bash
npx @dockerforge/cli generate ./my-app --output ./docker-output
```

After reviewing the generated files, build and run the image with Docker:

```bash
docker build -t my-app ./my-app
docker run --rm -p 3000:3000 my-app
```

Or use the generated Compose file:

```bash
cd ./my-app
docker compose up --build
```

The generated Dockerfile is multi-stage, runs as a non-root user, pins the base image tag, and adds a healthcheck:

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:20-alpine3.21 AS builder
WORKDIR /app
COPY package-lock.json package.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine3.21
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node","dist/index.js"]
```

## Lint Dockerfiles

Lint an existing Dockerfile and fail CI on real problems:

```bash
npx @dockerforge/cli lint ./Dockerfile --fail-on high
```

```text
DockerForge lint: 2 finding(s)

  [HIGH] DF001  Base image "node" has no tag (implies :latest).  Dockerfile:1
         fix: Pin to an explicit version, ideally a digest (e.g. node:20-alpine@sha256:...).
  [HIGH] DF002  Final USER is root.  Dockerfile:5
         fix: Switch to a non-root user before the start command.

  summary: 0 critical, 2 high, 0 medium, 0 low, 0 info
```

## Packages

| Package | Install | What it is |
| --- | --- | --- |
| [`@dockerforge/cli`](packages/cli) | `npm i -g @dockerforge/cli` | The command line tool. |
| [`@dockerforge/core`](packages/core) | `npm i @dockerforge/core` | The generation and linting engine for Node. |
| [`dockerforge`](https://www.npmjs.com/package/dockerforge) | `npm i -g dockerforge` | Optional unscoped alias package, if published. |

## Documentation

- [CLI reference](docs/cli.md): every command, flag, and exit code, plus CI examples.
- [Lint rules](docs/rules.md): what each rule checks, why it matters, and how to fix it.
- [Programmatic API](docs/programmatic.md): using `@dockerforge/core` from Node.
- [Release process](docs/release.md): local release checks, npm publishing, and GitHub releases.

## Releases

Releases are published to npm and mirrored on GitHub:

- [`@dockerforge/cli` on npm](https://www.npmjs.com/package/@dockerforge/cli)
- [`@dockerforge/core` on npm](https://www.npmjs.com/package/@dockerforge/core)
- [GitHub releases](https://github.com/Mo-ASayed/DockerForge/releases)

## Contributing

Contributions are welcome. Good places to help include new framework detection, lint rules, Dockerfile generation quality, docs, tests, and bug reports with small reproducible fixtures.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Open core

This repository contains the free, open-source DockerForge CLI and core engine, licensed under Apache-2.0. Local generation and linting run on your machine. A separate hosted product may add managed build verification and repository drift monitoring; that service is not part of this package.

## Develop

```bash
npm install
npm test
npm run verify
```

Tests use Node's built-in test runner and run offline against the sample projects in [`fixtures/`](fixtures).

`npm run verify` is the release gate. It runs tests, audits dependencies, inspects npm pack output, installs packed tarballs into fresh consumer projects, and runs the installed `dockerforge` command.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
