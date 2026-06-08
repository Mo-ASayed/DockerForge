// Part of the @dockerforge/core engine.
// Post-generation pass: check for obvious wins, add notes

function optimise(result, analysis) {
  const improvements = [...result.improvements];
  let dockerfile = result.dockerfile;
  const lines = dockerfile.split('\n');

  // Only count RUN instructions in the final stage. Builder-stage RUNs are
  // usually better kept separate because they preserve useful cache boundaries.
  const finalFromIdx = lines.reduce((last, line, idx) => (
    line.trim().startsWith('FROM ') ? idx : last
  ), 0);
  const finalStageRunLines = lines.slice(finalFromIdx).filter(l => l.trim().startsWith('RUN'));
  if (finalStageRunLines.length > 3) {
    improvements.push(
      `There are ${finalStageRunLines.length} RUN instructions in the final stage - consider chaining related ones with && to reduce runtime layers`
    );
  }

  // Check: large base image
  if (
    dockerfile.includes(':latest') ||
    (!dockerfile.includes('-alpine') && !dockerfile.includes('-slim'))
  ) {
    improvements.push(
      'Consider using an alpine or slim variant of the base image to reduce final image size'
    );
  }

  return {
    ...result,
    dockerfile,
    improvements,
  };
}

module.exports = { optimise };
