'use strict';

// Minimal, deterministic Dockerfile parser for the lint engine (Chunk 1.2).
// Not a full Dockerfile grammar - just enough to evaluate the 6 cheap rules reliably.
// Handles comments, blank lines, and backslash line-continuations, tracking line numbers.

function parseDockerfile(text) {
  const rawLines = String(text).split(/\r?\n/);
  const instructions = [];
  let i = 0;

  while (i < rawLines.length) {
    const startLine = i + 1;
    const trimmed = rawLines[i].trim();

    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }

    // Join continuation lines (trailing backslash).
    let content = rawLines[i];
    while (/\\\s*$/.test(content) && i + 1 < rawLines.length) {
      content = content.replace(/\\\s*$/, ' ');
      i++;
      content += rawLines[i];
    }

    const m = content.trim().match(/^(\w+)\s*([\s\S]*)$/);
    if (m) {
      instructions.push({
        instruction: m[1].toUpperCase(),
        args: (m[2] || '').trim(),
        line: startLine,
      });
    }
    i++;
  }

  return instructions;
}

// Split a flat instruction list into stages (one per FROM). Instructions before the
// first FROM (rare; e.g. top-level ARG) are ignored for stage-scoped rules.
function toStages(instructions) {
  const stages = [];
  let current = null;
  for (const ins of instructions) {
    if (ins.instruction === 'FROM') {
      current = { from: ins, instructions: [] };
      stages.push(current);
    } else if (current) {
      current.instructions.push(ins);
    }
  }
  return stages;
}

// Collect lowercased stage aliases (FROM x AS <alias>) so base-image rules can skip
// "FROM <previous-stage>" references.
function collectAliases(stages) {
  const aliases = new Set();
  for (const stage of stages) {
    const m = stage.from.args.match(/\s+AS\s+(\S+)\s*$/i);
    if (m) aliases.add(m[1].toLowerCase());
  }
  return aliases;
}

// Parse ENV pairs: supports "ENV K=V K2=V2" (quoted values) and legacy "ENV K V...".
function parseEnvPairs(args) {
  const t = args.trim();
  if (t.includes('=')) {
    const pairs = [];
    const re = /([A-Za-z_][\w.-]*)=("([^"]*)"|'([^']*)'|\S+)/g;
    let m;
    while ((m = re.exec(t))) {
      const value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[2]);
      pairs.push({ key: m[1], value });
    }
    return pairs;
  }
  const sp = t.split(/\s+/);
  const key = sp.shift();
  return key ? [{ key, value: sp.join(' ') }] : [];
}

// Parse "ARG KEY[=DEFAULT]".
function parseArg(args) {
  const t = args.trim();
  const eq = t.indexOf('=');
  if (eq === -1) return { key: t.split(/\s+/)[0] || '', value: null };
  return {
    key: t.slice(0, eq).trim(),
    value: t.slice(eq + 1).trim().replace(/^["']|["']$/g, ''),
  };
}

// Strip COPY/ADD flags (--from=, --chown=, --chmod=, --link) and return the remaining tokens.
function instructionTokens(args) {
  return args
    .replace(/--[\w-]+(=\S+)?/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

module.exports = {
  parseDockerfile,
  toStages,
  collectAliases,
  parseEnvPairs,
  parseArg,
  instructionTokens,
};
