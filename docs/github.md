# GitHub Repository Setup

Use these values for the GitHub repository About panel and public presentation.

## About

Description:

```text
Generate and lint production-grade Dockerfiles from the command line. Offline by default, no account required.
```

Website:

```text
https://www.npmjs.com/package/@dockerforge/cli
```

Topics:

```text
docker dockerfile containers containerization npm cli nodejs devops ci sarif security docker-compose
```

Enable:

- Issues
- Pull requests
- Releases
- Discussions, optional

## Packages

- `@dockerforge/cli`: the command line tool.
- `@dockerforge/core`: the generation and linting engine for Node.
- `dockerforge`: optional unscoped alias package, if published.

## Release Checklist

1. Update package versions and lockfile.
2. Add release notes under `docs/release-notes/vX.Y.Z.md`.
3. Run `npm run verify`.
4. Commit and push to `main`.
5. Run the GitHub Release workflow.
