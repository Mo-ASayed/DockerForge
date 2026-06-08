'use strict';

// Serialise a core LintResult to SARIF 2.1.0 (GitHub code-scanning compatible).
// Lives in the CLI, not core (core stays serialisation-free).

function sarifLevel(severity) {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note'; // low / info
}

function toSarif(result, dockerfileUri = 'Dockerfile') {
  const ruleIndex = {};
  const rules = [];

  const results = result.findings.map((f) => {
    if (!(f.ruleId in ruleIndex)) {
      ruleIndex[f.ruleId] = rules.length;
      rules.push({
        id: f.ruleId,
        name: f.ruleId,
        shortDescription: { text: f.message },
        defaultConfiguration: { level: sarifLevel(f.severity) },
        properties: { 'security-severity': severityScore(f.severity) },
      });
    }
    return {
      ruleId: f.ruleId,
      ruleIndex: ruleIndex[f.ruleId],
      level: sarifLevel(f.severity),
      message: { text: f.fixHint ? `${f.message} Fix: ${f.fixHint}` : f.message },
      locations: f.line
        ? [{
            physicalLocation: {
              artifactLocation: { uri: dockerfileUri },
              region: { startLine: f.line },
            },
          }]
        : [],
    };
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'DockerForge',
          informationUri: 'https://containerise.dev',
          rules,
        },
      },
      results,
    }],
  };
}

function severityScore(severity) {
  return ({ critical: '9.0', high: '7.0', medium: '5.0', low: '3.0', info: '1.0' })[severity] || '0.0';
}

module.exports = { toSarif, sarifLevel };
