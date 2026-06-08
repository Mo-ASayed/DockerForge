'use strict';

// The first-wave lint rules (Chunk 1.2): cheap, deterministic, low false-positive.
// Each rule: { id, title, check(ctx) -> Finding[] }. A Finding is
// { ruleId, severity, message, fixHint, line|null }.
// Second-wave rules (EOL base, multi-stage detection, apt cache, ADD-vs-COPY) come later.

const { parseEnvPairs, parseArg, instructionTokens } = require('./parse');

const SECRET_KEY = /(passwd|password|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth_?key)/i;
const ENV_EXCLUDE = ['.env', '.env*', '*.env', '.env.*', '**/.env'];

function finding(ruleId, severity, message, fixHint, line) {
  return { ruleId, severity, message, fixHint, line: line ?? null };
}

// DF001 - base image not pinned (:latest or no tag).
const unpinnedBase = {
  id: 'DF001',
  title: 'Base image is not pinned',
  check(ctx) {
    const out = [];
    for (const stage of ctx.stages) {
      let ref = stage.from.args.replace(/\s+AS\s+\S+\s*$/i, '').replace(/--platform=\S+\s*/i, '').trim();
      const base = ref.toLowerCase();
      if (!ref || base === 'scratch') continue;
      if (ctx.aliases.has(base)) continue;        // FROM <previous stage>
      if (ref.includes('@sha256:')) continue;      // digest-pinned
      const lastSeg = ref.split('/').pop();        // avoids registry:port false-positive
      const tag = lastSeg.includes(':') ? lastSeg.split(':').pop() : null;
      if (!tag) {
        out.push(finding('DF001', 'high', `Base image "${ref}" has no tag (implies :latest).`,
          'Pin to an explicit version, ideally a digest (e.g. node:20-alpine@sha256:...).', stage.from.line));
      } else if (tag === 'latest') {
        out.push(finding('DF001', 'high', `Base image "${ref}" uses the :latest tag.`,
          'Pin to an explicit version, ideally a digest, so builds are reproducible.', stage.from.line));
      }
    }
    return out;
  },
};

// DF002 - final stage runs as root (no non-root USER).
const rootUser = {
  id: 'DF002',
  title: 'Container runs as root',
  check(ctx) {
    const stage = ctx.stages[ctx.stages.length - 1];
    if (!stage) return [];
    const users = stage.instructions.filter((i) => i.instruction === 'USER');
    if (users.length === 0) {
      return [finding('DF002', 'high', 'No USER set in the final stage; the container runs as root.',
        'Create and switch to a non-root user before the start command (USER app).', stage.from.line)];
    }
    const last = users[users.length - 1];
    const u = (last.args.trim().split(/\s+/)[0] || '').toLowerCase();
    if (u === 'root' || u === '0') {
      return [finding('DF002', 'high', 'Final USER is root.',
        'Switch to a non-root user before the start command.', last.line)];
    }
    return [];
  },
};

// DF003 - COPY . . (leaks the whole build context, including secrets).
const copyDotDot = {
  id: 'DF003',
  title: 'COPY . . copies the entire context',
  check(ctx) {
    const out = [];
    for (const ins of ctx.instructions) {
      if (ins.instruction !== 'COPY') continue;
      const toks = instructionTokens(ins.args);
      if (toks.length === 2 && toks[0] === '.' && (toks[1] === '.' || toks[1] === './')) {
        out.push(finding('DF003', 'high', 'COPY . . copies the entire build context (risks leaking .env, secrets, .git).',
          'Copy only what you need (manifests, lockfiles, src/) and rely on a .dockerignore.', ins.line));
      }
    }
    return out;
  },
};

// DF004 - .dockerignore missing or does not exclude .env (needs filesystem context).
const dockerignoreEnv = {
  id: 'DF004',
  title: '.dockerignore missing or does not exclude .env',
  check(ctx) {
    if (!ctx.hasFsContext) return []; // raw-string lint: no sibling file to check
    if (!ctx.dockerignore || !ctx.dockerignore.exists) {
      return [finding('DF004', 'medium', 'No .dockerignore found next to the Dockerfile.',
        'Add a .dockerignore that excludes .env, node_modules, .git, and build output.', null)];
    }
    const lines = String(ctx.dockerignore.content).split(/\r?\n/).map((l) => l.trim());
    const excludesEnv = lines.some((l) => ENV_EXCLUDE.includes(l));
    if (!excludesEnv) {
      return [finding('DF004', 'medium', '.dockerignore does not exclude .env.',
        'Add a ".env" line (and ".env.*") so secrets never enter the build context.', null)];
    }
    return [];
  },
};

// DF005 - secret-like value hardcoded in ENV/ARG.
const hardcodedSecret = {
  id: 'DF005',
  title: 'Secret-like value hardcoded in ENV/ARG',
  check(ctx) {
    const out = [];
    const isVarRef = (v) => /^\$\{?\w+\}?$/.test(v);
    for (const ins of ctx.instructions) {
      if (ins.instruction === 'ENV') {
        for (const { key, value } of parseEnvPairs(ins.args)) {
          if (SECRET_KEY.test(key) && value && value.trim() !== '' && !isVarRef(value.trim())) {
            out.push(finding('DF005', 'critical', `ENV "${key}" hardcodes a secret-like value.`,
              'Do not bake secrets into the image. Pass at runtime (env/secret), not in the Dockerfile.', ins.line));
          }
        }
      } else if (ins.instruction === 'ARG') {
        const { key, value } = parseArg(ins.args);
        if (SECRET_KEY.test(key) && value && value.trim() !== '' && !isVarRef(value.trim())) {
          out.push(finding('DF005', 'critical', `ARG "${key}" has a secret-like default value baked into the image history.`,
            'Remove the default; supply secrets at build/run time via a secret mount, not ARG.', ins.line));
        }
      }
    }
    return out;
  },
};

// DF006 - final stage has no WORKDIR.
const missingWorkdir = {
  id: 'DF006',
  title: 'No WORKDIR set in the final stage',
  check(ctx) {
    const stage = ctx.stages[ctx.stages.length - 1];
    if (!stage) return [];
    const hasWorkdir = stage.instructions.some((i) => i.instruction === 'WORKDIR');
    if (!hasWorkdir) {
      return [finding('DF006', 'low', 'No WORKDIR set in the final stage; paths default to /.',
        'Set an explicit WORKDIR (e.g. WORKDIR /app) before COPY/RUN/CMD.', stage.from.line)];
    }
    return [];
  },
};

const RULES = [unpinnedBase, rootUser, copyDotDot, dockerignoreEnv, hardcodedSecret, missingWorkdir];

module.exports = { RULES };
