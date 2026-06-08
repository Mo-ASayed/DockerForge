'use strict';

const { ingestGitRepo, ingestZip, ingestTree } = require('./ingestion/ingestion');
const { analyseProject } = require('./analysis/analyser');
const { generateDockerfile, addPowerDockerfileHeader } = require('./generation/generator');
const { optimise } = require('./optimisation/optimiser');
const { securityPass } = require('./security/security');
const { buildExplanation } = require('./explanation/explainer');
const { generateCompose } = require('./generation/composeGenerator');

function clampScore(score) {
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function confidenceLabel(score) {
  if (score >= 0.9) return 'High';
  if (score >= 0.7) return 'Medium';
  if (score >= 0.4) return 'Low';
  return 'Unsupported/Risky';
}

function collectAssumptions(analysisResult) {
  return analysisResult.services.flatMap(service =>
    (service.assumptions || []).map(item => `${service.serviceDir}: ${item}`)
  );
}

function buildWarnings({ analysisResult, result, securityNotes }) {
  const warnings = [];
  for (const note of securityNotes) {
    if (/security|warning|avoid|possible|root|latest/i.test(note)) warnings.push(note);
  }
  for (const note of result.improvements || []) {
    if (/verify|must|warning|blocked|assumption|source|healthcheck/i.test(note)) warnings.push(note);
  }
  for (const service of analysisResult.services) {
    if (service.stack === 'python') {
      warnings.push(`${service.serviceDir}: Python source copy confidence needs review; verify all package, template, static, and migration directories are copied.`);
    }
    if (service.stack === 'node' && !service.lockFile) {
      warnings.push(`${service.serviceDir}: no Node lockfile detected; dependency installs may not be reproducible.`);
    }
  }
  return [...new Set(warnings)];
}

function scoreConfidence({ analysisResult, warnings }) {
  let score = 1;
  const reasons = [];
  const assumptions = collectAssumptions(analysisResult);

  if (analysisResult.services.length > 1) {
    score -= 0.04;
    reasons.push(`${analysisResult.services.length} services detected`);
  }

  for (const service of analysisResult.services) {
    if (!service.version) {
      score -= 0.15;
      reasons.push(`${service.serviceDir}: runtime version missing`);
    }
    if (service.stack === 'node') {
      if (!service.lockFile) {
        score -= 0.18;
        reasons.push(`${service.serviceDir}: lockfile missing`);
      }
      if (!service.startCmd || service.startCmd.length === 0) {
        score -= 0.2;
        reasons.push(`${service.serviceDir}: start command uncertain`);
      }
    }
    if (service.stack === 'python') {
      if (!service.entryPoint && !service.appTarget) {
        score -= 0.2;
        reasons.push(`${service.serviceDir}: Python entrypoint uncertain`);
      }
      if (!service.sourceCopyConfidence || service.sourceCopyConfidence !== 'high') {
        score -= 0.12;
        reasons.push(`${service.serviceDir}: Python source copy needs review`);
      }
    }
    if ((service.assumptions || []).length > 0) {
      score -= Math.min(0.18, service.assumptions.length * 0.06);
    }
  }

  const majorWarnings = warnings.filter(w => /security|must|not detected|permission denied|invalid|unsafe/i.test(w));
  if (majorWarnings.length > 0) {
    score -= Math.min(0.18, majorWarnings.length * 0.04);
  }

  const finalScore = clampScore(score);
  const label = confidenceLabel(finalScore);
  let reason;
  if (reasons.length > 0) {
    reason = reasons.slice(0, 2).join('; ');
  } else if (assumptions.length > 0) {
    reason = `${assumptions.length} assumption${assumptions.length === 1 ? '' : 's'} detected.`;
  } else if (warnings.length > 0) {
    reason = `${warnings.length} warning${warnings.length === 1 ? '' : 's'} to review.`;
  } else {
    reason = 'Stack, runtime, dependencies, and start command were detected with no major warnings.';
  }

  return { confidence: finalScore, confidenceLabel: label, confidenceReason: reason };
}

function applyValidationEvidence(confidenceResult, validation) {
  if (!validation || validation.status === 'skipped') return confidenceResult;

  if (validation.status === 'passed') {
    const delta = validation.evidence?.runtimePassed ? 0.12 : 0.08;
    const confidence = clampScore(confidenceResult.confidence + delta);
    return {
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      confidenceReason: `${confidenceResult.confidenceReason} Build/runtime validated.`,
    };
  }

  if (validation.status === 'failed') {
    const confidence = clampScore(confidenceResult.confidence - 0.2);
    return {
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      confidenceReason: `${confidenceResult.confidenceReason} Validation failed during ${validation.stage}.`,
    };
  }

  return confidenceResult;
}

/**
 * Strip BuildKit-specific features from a Dockerfile to produce the simple default output.
 * Build environment prefixes stay in both outputs because they are part of the recipe.
 */
function toSimpleDockerfile(dockerfile) {
  return dockerfile.split('\n').map(line => {
    const isRun = /^RUN\s/.test(line);
    if (!isRun) return line;
    // Strip --mount=type=cache,... and --mount=type=secret,...
    line = line.replace(/--mount=type=\w+,\S+\s+/g, '');
    return line;
  }).join('\n');
}


async function resolveProjectPath(input) {
  if (input.projectPath) return input.projectPath;
  if (input.gitUrl) return ingestGitRepo(input.gitUrl, input.workDir, input.pat);
  if (input.zipPath) return ingestZip(input.zipPath, input.workDir);
  if (input.fileTree) return ingestTree(input.fileTree, input.workDir);
  throw new Error('Provide projectPath, gitUrl, zipPath, or fileTree');
}

async function runDockerfileEngine(input = {}) {
  const projectPath = await resolveProjectPath(input);
  const analysisResult = await analyseProject(projectPath, input.hints || {});
  const primaryService = analysisResult.services[0];

  let result = generateDockerfile(analysisResult);
  const composeResult = generateCompose(analysisResult);

  if (input.optimise !== false) {
    result = optimise(result, primaryService);
  }

  const securityNotes = input.security === false ? [] : securityPass(result, primaryService);
  const explanation = buildExplanation(primaryService, result, securityNotes);
  const improvements = [...securityNotes, ...(result.improvements || []), ...(composeResult.improvements || [])];
  const assumptions = collectAssumptions(analysisResult);
  const warnings = buildWarnings({ analysisResult, result, securityNotes });
  const confidence = applyValidationEvidence(
    scoreConfidence({ analysisResult, warnings }),
    input.validation
  );

  const fullDockerfile   = result.dockerfile;
  const powerDockerfile  = addPowerDockerfileHeader(fullDockerfile);
  const simpleDockerfile = toSimpleDockerfile(fullDockerfile);

  return {
    dockerfile: simpleDockerfile,
    powerDockerfile,
    validationDockerfile: result.validationDockerfile || null,
    validationDrift: result.validationDrift || null,
    dockerignore: result.dockerignore,
    nginxConf: result.nginxConf || null,
    compose: composeResult.compose || null,
    explanation,
    improvements,
    warnings,
    assumptions,
    validation: input.validation || null,
    analysis: {
      services: analysisResult.services.map(service => ({
        stack: service.stack,
        role: service.role,
        serviceDir: service.serviceDir,
        version: service.version,
        framework: service.framework || null,
        port: service.port,
      })),
    },
    ...confidence,
  };
}

module.exports = {
  applyValidationEvidence,
  runDockerfileEngine,
  scoreConfidence,
  buildWarnings,
};
