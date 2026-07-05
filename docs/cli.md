# CLI reference

The `dockerforge` command has two subcommands: `generate` and `lint`. Both run offline.

Run it directly with npm:

```bash
npx @dockerforge/cli generate ./my-app
```

Or install the canonical CLI package globally:

```bash
npm install -g @dockerforge/cli
dockerforge generate ./my-app
```

```text
dockerforge <command> [path] [options]

Commands:
  generate [path]   Generate a Dockerfile, .dockerignore, and Compose file
  lint     [path]   Lint a Dockerfile against the DockerForge rules

Options:
  -v, --version     Print the version
  -h, --help        Print help for a command
```

`path` defaults to the current directory.

## generate

Analyse a project directory and produce a Dockerfile, a `.dockerignore`, and a Compose file.

```bash
dockerforge generate ./my-app
```

Run it from inside a project to write files into that project:

```bash
cd ./my-app
dockerforge generate .
```

The default generated files are:

```text
Dockerfile
.dockerignore
docker-compose.yml
```

### Options

| Flag | Default | Effect |
| --- | --- | --- |
| `-o, --output <dir>` | the target path | Directory to write the files into. |
| `--print` | off | Print the Dockerfile to stdout and write nothing. |
| `--json` | off | Print a JSON object instead of the human summary. |
| `--stack <name>` | auto | Override stack detection, for example `node`, `python`, `dotnet`. |
| `--port <n>` | auto | Set the exposed port. |
| `--no-optimise` | on | Skip the optimisation pass. |
| `--no-security` | on | Skip the security pass. |

### Output

Default output is a coloured summary: the detected stack, a confidence score between 0 and 1, the
files written, and any warnings. Colour is disabled automatically when stdout is not a terminal or
when `NO_COLOR` is set.

`--json` prints a machine-readable object:

```json
{
  "dockerfile": "# syntax=docker/dockerfile:1\nFROM ...",
  "dockerignore": "node_modules\n.git\n...",
  "compose": "services:\n  app:\n    build: .\n...",
  "confidence": 0.94,
  "improvements": ["..."]
}
```

`--print` writes only the Dockerfile text to stdout, which is convenient for piping:

```bash
dockerforge generate . --print | docker build -t my-app -f - .
```

### Examples

```bash
# Generate into the app directory
dockerforge generate ./my-app

# Write into a separate directory
dockerforge generate ./service --output ./service/docker

# Force a stack and port instead of relying on detection
dockerforge generate . --stack python --port 8000

# Inspect the result without writing anything
dockerforge generate . --print
```

After reviewing the generated files, build and run the image:

```bash
docker build -t my-app ./my-app
docker run --rm -p 3000:3000 my-app
```

Or use the generated Compose file:

```bash
cd ./my-app
docker compose up --build
```

## lint

Check a Dockerfile against the DockerForge rules. Pass a Dockerfile, or a directory that contains
one.

```bash
dockerforge lint ./Dockerfile
```

### Options

| Flag | Default | Effect |
| --- | --- | --- |
| `--format <fmt>` | `human` | Output format: `human`, `json`, or `sarif`. |
| `--fail-on <severity>` | `high` | Lowest severity that makes the command exit non-zero: `info`, `low`, `medium`, `high`, `critical`. |
| `--rules <ids>` | all | Comma-separated rule ids to run, for example `DF001,DF002`. |

### Formats

`human` prints one block per finding with the severity, rule id, location, and a fix hint:

```text
DockerForge lint: 2 finding(s)

  [HIGH] DF001  Base image "node" has no tag (implies :latest).  Dockerfile:1
         fix: Pin to an explicit version, ideally a digest (e.g. node:20-alpine@sha256:...).
  [HIGH] DF002  Final USER is root.  Dockerfile:5
         fix: Switch to a non-root user before the start command.

  summary: 0 critical, 2 high, 0 medium, 0 low, 0 info
```

`json` prints `{ findings, summary }`, where each finding has `ruleId`, `severity`, `message`,
and a `line` when one applies.

`sarif` prints SARIF 2.1.0, which uploads directly to GitHub code scanning or any SARIF viewer.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--fail-on`. |
| `1` | Lint found at least one issue at or above `--fail-on`. |
| `2` | A tool error (bad path, unreadable file, invalid `--fail-on`). |

The split between `1` and `2` lets CI tell a policy failure (an issue in the Dockerfile) apart
from a tooling error (something went wrong running the lint). `generate` exits `0` on success and
`1` on error.

## Continuous integration

Fail a pull request on any high-severity issue:

```yaml
- run: npx @dockerforge/cli lint . --fail-on high
```

Upload findings to GitHub code scanning so they appear inline on the pull request:

```yaml
- run: npx @dockerforge/cli lint . --format sarif > dockerforge.sarif
  continue-on-error: true
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: dockerforge.sarif
```

Generate a Dockerfile and check it in the same job:

```yaml
- run: npx @dockerforge/cli generate . --output .
- run: npx @dockerforge/cli lint . --fail-on high
```
