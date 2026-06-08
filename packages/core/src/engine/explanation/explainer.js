// Part of the @dockerforge/core engine.
// Turns analysis + result into a human-readable explanation

const { STACKS } = require('../constants');

function buildExplanation(analysis, result, securityNotes) {
  const stackNames = {
    [STACKS.NODE]: 'Node.js',
    [STACKS.PYTHON]: 'Python',
    [STACKS.DOTNET]: '.NET',
  };

  const lines = [];

  lines.push(`**Stack detected:** ${stackNames[analysis.stack]}`);
  lines.push(`**Runtime version:** ${analysis.version}`);

  // Base image reasoning
  if (analysis.stack === STACKS.NODE) {
    lines.push(
      `**Base image:** \`node:${analysis.version}-alpine\` (Alpine Linux keeps the image small, ~50MB vs ~900MB for the full Debian image).`
    );
    lines.push(`**Package manager:** ${analysis.packageManager} (detected from lockfile)`);
    if (analysis.hasBuild) {
      lines.push(
        `**Build strategy:** Multi-stage build. A build container compiles the app, then only the output is copied to a clean runtime container. Dev dependencies never reach production.`
      );
    } else {
      lines.push(
        `**Build strategy:** Single stage. No build script detected, so all dependencies are installed directly in the runtime container with \`--omit=dev\` to exclude dev packages.`
      );
    }
  }

  if (analysis.stack === STACKS.PYTHON) {
    lines.push(
      `**Base image:** \`python:${analysis.version}-slim\` (Debian slim removes most docs and locales, saving ~100MB vs the full image).`
    );
    if (analysis.framework) {
      lines.push(`**Framework detected:** ${analysis.framework}, start command tuned accordingly.`);
    }
    lines.push(
      `**PYTHONDONTWRITEBYTECODE + PYTHONUNBUFFERED set:** prevents .pyc clutter and ensures logs appear immediately in Docker.`
    );
  }

  if (analysis.stack === STACKS.DOTNET) {
    lines.push(
      `**Base images:** SDK image (\`mcr.microsoft.com/dotnet/sdk:${analysis.version}\`) used to build, then the much smaller ASP.NET runtime image (\`mcr.microsoft.com/dotnet/aspnet:${analysis.version}\`) for production. SDK is ~750MB, runtime is ~220MB.`
    );
    lines.push(`**Multi-stage build:** Always used for .NET. The SDK is never shipped to production.`);
  }

  // Port
  lines.push(`**Port:** \`${analysis.port}\` exposed`);

  // Security
  lines.push(`**Security:** Non-root user added. Container does not run as root.`);

  // Cache optimisation
  lines.push(
    `**Layer caching:** Lockfile and package manifest are copied before the rest of the app. This means \`docker build\` only re-runs the install step if your dependencies actually changed.`
  );

  return {
    summary: lines.join('\n'),
    stack: stackNames[analysis.stack],
    version: analysis.version,
    port: analysis.port,
    multiStage: analysis.hasBuild,
    packageManager: analysis.packageManager || null,
    framework: analysis.framework || null,
    assumptions: analysis.assumptions || [],
    securityChecks: securityNotes,
  };
}

module.exports = { buildExplanation };
