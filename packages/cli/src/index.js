#!/usr/bin/env node
'use strict';

// @dockerforge/cli - the offline CLI wedge (Chunk 1.1).
// Consumes @dockerforge/core (the deferred 0.3 consumer-repoint lands here). Does NOT touch
// api/* and makes no network calls - generation is fully local.

const path = require('path');
const fs = require('fs/promises');
const { Command } = require('commander');
const { version } = require('../package.json');

const core = require('@dockerforge/core');
const { toSarif } = require('./sarif');

// ---- tiny colour helper (no dependency; respects NO_COLOR and non-TTY) --------------------
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const red = (s) => paint('31', s);
const cyan = (s) => paint('36', s);

function confidenceColour(label) {
  if (label === 'High') return green;
  if (label === 'Medium') return yellow;
  return red; // Low / Unsupported/Risky
}

const program = new Command();

program
  .name('dockerforge')
  .description('Generate production-grade Dockerfiles from a local project (offline)')
  .version(version, '-v, --version');

program
  .command('generate')
  .description('Generate a Dockerfile, .dockerignore, and Compose for a local project directory')
  .argument('[path]', 'Target project directory', '.')
  .option('-o, --output <dir>', 'Write output to this directory (default: same as [path])')
  .option('--print', 'Print Dockerfile to stdout instead of writing files')
  .option('--no-optimise', 'Skip optimisation pass')
  .option('--no-security', 'Skip security pass')
  .option('--stack <stack>', 'Hint the stack (node, python, dotnet, ...)')
  .option('--port <port>', 'Hint the exposed port', (v) => parseInt(v, 10))
  .option('--pin-digests', 'Resolve Docker Hub base-image tags to immutable sha256 digests (network)')
  .option('--json', 'Output JSON {dockerfile, dockerignore, compose, confidence, improvements}')
  .action(async (targetPath, opts) => {
    try {
      const hints = {};
      if (opts.stack) hints.stack = opts.stack;
      if (opts.port) hints.port = opts.port;

      const projectPath = await core.ingestLocal(targetPath);

      if (!opts.json && !opts.print) process.stderr.write(dim('  analysing...\n'));
      const result = await core.runDockerfileEngine({
        projectPath,
        hints,
        optimise: opts.optimise,
        security: opts.security,
        pinDigests: opts.pinDigests,
        digestResolver: process.env.DOCKERFORGE_TEST_DIGEST
          ? async (imageRef) => ({
            original: imageRef,
            pinned: `${imageRef}@${process.env.DOCKERFORGE_TEST_DIGEST}`,
            digest: process.env.DOCKERFORGE_TEST_DIGEST,
          })
          : undefined,
      });

      // --- machine output: keep byte-identical shape to the old CLI for CI use ---
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          dockerfile: result.dockerfile,
          dockerignore: result.dockerignore,
          nginxConf: result.nginxConf,
          compose: result.compose,
          explanation: result.explanation,
          improvements: result.improvements,
          warnings: result.warnings,
          assumptions: result.assumptions,
          confidence: result.confidence,
          confidenceLabel: result.confidenceLabel,
          confidenceReason: result.confidenceReason,
        }, null, 2) + '\n');
        return;
      }

      if (opts.print) {
        process.stdout.write('# Dockerfile\n');
        process.stdout.write(result.dockerfile + '\n');
        if (result.dockerignore) {
          process.stdout.write('\n# .dockerignore\n');
          process.stdout.write(result.dockerignore + '\n');
        }
        if (result.nginxConf) {
          process.stdout.write('\n# nginx.conf\n');
          process.stdout.write(result.nginxConf + '\n');
        }
        return;
      }

      // --- write files (byte-identical to the old CLI) ---
      const outDir = opts.output ? path.resolve(opts.output) : projectPath;
      await fs.mkdir(outDir, { recursive: true });

      const written = [];
      const writeOut = async (name, contents) => {
        if (!contents) return;
        const p = path.join(outDir, name);
        await fs.writeFile(p, contents, 'utf8');
        written.push(p);
      };

      await writeOut('Dockerfile', result.dockerfile);
      await writeOut('.dockerignore', result.dockerignore);
      await writeOut('nginx.conf', result.nginxConf);
      await writeOut('docker-compose.yml', result.compose);

      // --- DX summary (default mode only) ---
      const services = result.analysis.services
        .map((s) => `${s.serviceDir}(${s.stack})`)
        .join(', ');
      const cc = confidenceColour(result.confidenceLabel);

      console.log('');
      console.log(bold('DockerForge'));
      console.log(`  Services   ${result.analysis.services.length} found ${dim('[' + services + ']')}`);
      console.log(`  Confidence ${cc(result.confidenceLabel)} ${dim('(' + result.confidence.toFixed(2) + ')')}`);
      console.log(`             ${dim(result.confidenceReason)}`);
      const warnCount = result.warnings.length;
      console.log(`  Warnings   ${warnCount ? yellow(String(warnCount)) : green('0')}`);
      console.log('');
      for (const p of written) console.log('  ' + green('written') + '  ' + p);

      if (warnCount) {
        console.log('');
        console.log(yellow('  Review before shipping:'));
        result.warnings.forEach((w) => console.log('   - ' + w));
      }

      console.log('');
      console.log(dim('  next: ') + cyan('dockerforge validate ' + (opts.output || targetPath)) + dim('  (cloud build-and-run, coming in Phase 2)'));
    } catch (err) {
      const code = err && err.code ? ` [${err.code}]` : '';
      console.error(red('Error' + code + ':'), err.message);
      process.exit(1);
    }
  });

// ---- severity helpers for lint exit codes / colouring ----
const SEV_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
function sevColour(sev) {
  if (sev === 'critical' || sev === 'high') return red;
  if (sev === 'medium') return yellow;
  return dim; // low / info
}

program
  .command('lint [path]')
  .description('Lint a Dockerfile (or a directory containing one) against DockerForge rules')
  .option('--format <fmt>', 'Output format: human | json | sarif', 'human')
  .option('--fail-on <severity>', 'Minimum severity that fails the run: info|low|medium|high|critical', 'high')
  .option('--rules <ids>', 'Comma-separated rule ids to run (default: all)')
  .action(async (targetPath, opts) => {
    try {
      const options = {};
      if (opts.rules) options.rules = opts.rules.split(',').map((s) => s.trim()).filter(Boolean);

      const result = await core.lint(targetPath || '.', options);

      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (opts.format === 'sarif') {
        process.stdout.write(JSON.stringify(toSarif(result), null, 2) + '\n');
      } else {
        printLintHuman(result);
      }

      const threshold = SEV_ORDER.indexOf(opts.failOn);
      if (threshold === -1) {
        console.error(red(`Error: invalid --fail-on "${opts.failOn}" (use info|low|medium|high|critical)`));
        process.exit(2);
      }
      const failed = result.findings.some((f) => SEV_ORDER.indexOf(f.severity) >= threshold);
      process.exit(failed ? 1 : 0);
    } catch (err) {
      const code = err && err.code ? ` [${err.code}]` : '';
      console.error(red('Error' + code + ':'), err.message);
      process.exit(2); // tool error (distinct from "violations found" = 1)
    }
  });

function printLintHuman(result) {
  const { findings, summary } = result;
  if (findings.length === 0) {
    console.log(green('\nDockerForge lint: no issues found.\n'));
    return;
  }
  console.log(bold(`\nDockerForge lint: ${findings.length} finding(s)\n`));
  for (const f of findings) {
    const col = sevColour(f.severity);
    const loc = f.line ? dim(`Dockerfile:${f.line}`) : dim('(project)');
    console.log(`  ${col('[' + f.severity.toUpperCase() + ']')} ${bold(f.ruleId)}  ${f.message}  ${loc}`);
    if (f.fixHint) console.log(`         ${dim('fix: ' + f.fixHint)}`);
  }
  const c = summary.counts;
  console.log('');
  console.log(dim(`  summary: ${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low, ${c.info} info`));
  console.log('');
}

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exitCode = 1;
} else {
  program.parseAsync(process.argv);
}
