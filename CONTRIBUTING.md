# Contributing

Contributions are welcome. DockerForge is a small CLI and Node engine, so useful changes are easiest to review when they stay focused.

## Good first contributions

- Add or improve stack detection for a common framework.
- Add a small fixture under `fixtures/` and cover it with a test.
- Improve generated Dockerfiles for an existing stack.
- Add or refine a lint rule in `@dockerforge/core`.
- Improve docs where the CLI behaviour is unclear.

## Local setup

```bash
npm install
npm test
```

Before opening a pull request, run the full release gate:

```bash
npm run verify
```

`npm run verify` runs tests, audits dependencies, checks packed npm output, installs packed tarballs into fresh projects, and runs the installed CLI.

## Pull requests

- Keep pull requests small and focused.
- Include tests for behaviour changes.
- Include docs when a command, option, output format, or public API changes.
- Do not commit generated tarballs, local logs, private planning notes, or editor files.
- Use clear commit messages, for example `feat: add rails detection` or `fix: avoid root runtime user`.

## Bug reports

Good bug reports include:

- The command you ran.
- The project stack, for example Node, Python, Go, Rust, .NET, or static SPA.
- The generated Dockerfile or lint finding.
- The expected result.
- A small reproduction, if possible.

## Security

Do not open a public issue for a sensitive security report. Use GitHub private vulnerability reporting if it is enabled, or contact the maintainer privately.

## Licence

By contributing, you agree that your contribution is licensed under the Apache-2.0 licence used by this repository.
