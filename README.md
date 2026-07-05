# DockerForge

Generate and lint production-grade Dockerfiles from the command line. Offline, no account.

[![npm (cli)](https://img.shields.io/npm/v/@dockerforge/cli?label=%40dockerforge%2Fcli)](https://www.npmjs.com/package/@dockerforge/cli)
[![npm (core)](https://img.shields.io/npm/v/@dockerforge/core?label=%40dockerforge%2Fcore)](https://www.npmjs.com/package/@dockerforge/core)
[![license](https://img.shields.io/npm/l/@dockerforge/cli)](LICENSE)
[![node](https://img.shields.io/node/v/@dockerforge/cli)](https://nodejs.org)

Point it at a project and it detects the stack, then writes a Dockerfile, a `.dockerignore`,
and a Compose file, with a confidence score and warnings. It also lints existing Dockerfiles and
reports findings as human text, JSON, or SARIF. Everything runs on your machine and makes no
network calls.

## Quick start

```bash
npx @dockerforge/cli generate ./my-app
```

For repeated use, install the canonical CLI package globally:

```bash
npm install -g @dockerforge/cli
dockerforge generate ./my-app
```

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

Run DockerForge from the root of the app you want to containerize:

```bash
cd ./my-app
npx @dockerforge/cli generate .
```

DockerForge writes:

```text
Dockerfile
.dockerignore
docker-compose.yml
```

To preview the Dockerfile before writing files:

```bash
npx @dockerforge/cli generate ./my-app --print
```

To write the files somewhere else:

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

The generated Dockerfile is multi-stage, runs as a non-root user, pins the base image, and adds
a healthcheck:

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
| [`@dockerforge/core`](packages/core) | `npm i @dockerforge/core` | The engine, for use from Node. |

## Documentation

- [CLI reference](docs/cli.md) — every command, flag, and exit code, plus CI examples.
- [Lint rules](docs/rules.md) — what each rule checks, why it matters, and how to fix it.
- [Programmatic API](docs/programmatic.md) — using `@dockerforge/core` from Node.

## Open core

This repository is the free, open-source part of DockerForge, licensed under Apache-2.0:
local generation and linting that run entirely on your machine. A separate hosted product builds
and runs the image to confirm it works and watches repositories for drift over time. That part is
commercial and is not in this repository.

## Develop

```bash
npm install
npm test
npm run verify
```

Tests use Node's built-in test runner and run offline against the sample projects in
[`fixtures/`](fixtures).

`npm run verify` is the release gate: it runs tests, audits dependencies, inspects npm pack output,
installs packed tarballs into fresh consumer projects, and runs the installed `dockerforge` command.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
