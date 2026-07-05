# @dockerforge/cli

Generate and lint production-grade Dockerfiles from the command line. Offline, no account.

[![npm](https://img.shields.io/npm/v/@dockerforge/cli)](https://www.npmjs.com/package/@dockerforge/cli)
[![license](https://img.shields.io/npm/l/@dockerforge/cli)](https://github.com/Mo-ASayed/DockerForge/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@dockerforge/cli)](https://nodejs.org)

Point it at a project directory and it detects the stack, then writes a Dockerfile, a
`.dockerignore`, and a Compose file, with a confidence score and warnings. It also lints
existing Dockerfiles and reports findings as human text, JSON, or SARIF. Everything runs on your
machine and makes no network calls.

## Install

Run it directly with npx:

```bash
npx @dockerforge/cli generate ./my-app
```

Or install it globally:

```bash
npm install -g @dockerforge/cli
dockerforge generate ./my-app
```

## Generate

Run DockerForge from the root of the app you want to containerize:

```bash
cd ./my-app
npx @dockerforge/cli generate .
```

It writes a `Dockerfile`, `.dockerignore`, and `docker-compose.yml` by default.

```bash
dockerforge generate .                 # write files into the current directory
dockerforge generate ./app -o ./out    # write into a chosen directory
dockerforge generate . --print         # print the Dockerfile, write nothing
dockerforge generate . --json          # JSON output for scripts and CI
dockerforge generate . --pin-digests   # resolve Docker Hub base images to sha256 digests
```

| Flag | Effect |
| --- | --- |
| `-o, --output <dir>` | Write output to this directory. Defaults to the target path. |
| `--print` | Print the Dockerfile to stdout instead of writing files. |
| `--json` | Print `{ dockerfile, dockerignore, compose, confidence, improvements }`. |
| `--pin-digests` | Resolve Docker Hub base-image tags to immutable SHA-256 digests. Makes live registry requests. |
| `--stack <name>` | Override stack detection (`node`, `python`, `dotnet`, ...). |
| `--port <n>` | Set the exposed port. |
| `--no-optimise` | Skip the optimisation pass. |
| `--no-security` | Skip the security pass. |

The default output is a coloured summary with the detected services, a confidence score, and any
warnings. `--json` and `--print` produce plain output with no decoration. Colour turns off when
the output is not a terminal or when `NO_COLOR` is set.

Default generation is offline. `--pin-digests` is opt-in because it contacts Docker Hub to turn
base-image tags such as `node:20-alpine3.21` into `node:20-alpine3.21@sha256:...`. Digest-pinned
images stay fixed until you update them, so pair this with Docker Scout, Renovate, Dependabot, or
another digest refresh process.

After reviewing the generated files, build and run with Docker:

```bash
docker build -t my-app .
docker run --rm -p 3000:3000 my-app
```

Or use the generated Compose file:

```bash
docker compose up --build
```

## Lint

```bash
dockerforge lint ./Dockerfile
dockerforge lint . --format sarif > results.sarif
dockerforge lint . --fail-on medium
dockerforge lint . --rules DF001,DF002
```

| Flag | Effect |
| --- | --- |
| `--format <fmt>` | `human` (default), `json`, or `sarif`. |
| `--fail-on <severity>` | Lowest severity that fails the run: `info`, `low`, `medium`, `high`, `critical`. Default `high`. |
| `--rules <ids>` | Comma-separated rule ids to run. Default is all rules. |

| Id | Check | Severity |
| --- | --- | --- |
| DF001 | Base image is not pinned (no tag, or `:latest`) | high |
| DF002 | Final stage runs as root | high |
| DF003 | `COPY . .` copies the whole build context | high |
| DF004 | `.dockerignore` is missing or does not exclude `.env` | medium |
| DF005 | A secret-like value is hardcoded in `ENV` or `ARG` | critical |
| DF006 | No `WORKDIR` is set in the final stage | low |

The `sarif` format follows SARIF 2.1.0, so the output drops straight into GitHub code scanning or
any SARIF viewer. Full detail for each rule is in the [rules reference](https://github.com/Mo-ASayed/DockerForge/blob/main/docs/rules.md).

## Exit codes

`lint`:

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--fail-on`. |
| `1` | Lint found at least one issue at or above `--fail-on`. |
| `2` | A tool error (bad path, unreadable file, invalid `--fail-on`). |

`generate`:

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | An error. The human error line includes a typed code when one is available, for example `PATH_NOT_FOUND`. |

## Use in CI

Fail a pull request when a Dockerfile has a high-severity issue:

```yaml
- run: npx @dockerforge/cli lint . --fail-on high
```

Upload findings to GitHub code scanning:

```yaml
- run: npx @dockerforge/cli lint . --format sarif > dockerforge.sarif
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: dockerforge.sarif
```

## Documentation

- [CLI reference](https://github.com/Mo-ASayed/DockerForge/blob/main/docs/cli.md)
- [Lint rules](https://github.com/Mo-ASayed/DockerForge/blob/main/docs/rules.md)
- [Programmatic API](https://github.com/Mo-ASayed/DockerForge/blob/main/docs/programmatic.md)

## License

Apache-2.0. Built on [`@dockerforge/core`](https://www.npmjs.com/package/@dockerforge/core).
