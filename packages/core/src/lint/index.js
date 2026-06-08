'use strict';

// @dockerforge/core lint engine (Chunk 1.2). Offline, pure-ish (reads local files only).
// Returns a LintResult per the contract (Section 2.3). Serialisation (SARIF/JSON/human) is
// the CLI's job, not core's.

const path = require('path');
const fs = require('fs/promises');

const { parseDockerfile, toStages, collectAliases } = require('./parse');
const { RULES } = require('./rules');
const errors = require('../errors');

const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];

async function readIfExists(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

// Resolve the lint target into { dockerfileText, fsContext }.
// target: string (path to a Dockerfile or a project dir) OR { dockerfile: string }.
async function resolveTarget(target) {
  if (target && typeof target === 'object' && typeof target.dockerfile === 'string') {
    return { dockerfileText: target.dockerfile, fsContext: { hasFsContext: false, dockerignore: null } };
  }
  if (typeof target !== 'string') {
    throw new errors.IngestError('lint target must be a path string or { dockerfile } object');
  }

  const resolved = path.resolve(target);
  let stat;
  try { stat = await fs.stat(resolved); }
  catch { throw new errors.PathNotFoundError(`Path not found: ${resolved}`); }

  let dockerfilePath;
  let dir;
  if (stat.isDirectory()) {
    dir = resolved;
    dockerfilePath = path.join(resolved, 'Dockerfile');
  } else {
    dir = path.dirname(resolved);
    dockerfilePath = resolved;
  }

  const dockerfileText = await readIfExists(dockerfilePath);
  if (dockerfileText === null) {
    throw new errors.PathNotFoundError(`Dockerfile not found: ${dockerfilePath}`);
  }

  const diContent = await readIfExists(path.join(dir, '.dockerignore'));
  return {
    dockerfileText,
    fsContext: {
      hasFsContext: true,
      dockerignore: diContent === null ? { exists: false, content: '' } : { exists: true, content: diContent },
    },
  };
}

/**
 * Lint a Dockerfile.
 * @param {string|{dockerfile:string}} target
 * @param {{failOn?:string, rules?:string[]}} [options]
 * @returns {Promise<{findings:Array, summary:{counts:object, worst:string|null}}>}
 */
async function lint(target, options = {}) {
  const { dockerfileText, fsContext } = await resolveTarget(target);

  const instructions = parseDockerfile(dockerfileText);
  const stages = toStages(instructions);
  const aliases = collectAliases(stages);
  const ctx = { instructions, stages, aliases, ...fsContext };

  const enabled = options.rules && options.rules.length ? new Set(options.rules) : null;

  let findings = [];
  for (const rule of RULES) {
    if (enabled && !enabled.has(rule.id)) continue;
    findings = findings.concat(rule.check(ctx));
  }

  findings.sort((a, b) => (a.line || 0) - (b.line || 0) || a.ruleId.localeCompare(b.ruleId));

  const counts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) counts[f.severity]++;
  let worst = null;
  for (const s of SEVERITY_ORDER) if (counts[s] > 0) worst = s;

  return { findings, summary: { counts, worst } };
}

module.exports = { lint, SEVERITY_ORDER };
