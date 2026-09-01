import { Spread, separated } from './metrics';
import { EvalReport } from './runner';

const PERCENT = (value: number): string => `${(value * 100).toFixed(1)}%`;

function spreadCell(spread: Spread, format: (v: number) => string): string {
  if (spread.n === 0) return '—';
  return spread.stdev === 0
    ? format(spread.mean)
    : `${format(spread.mean)} ±${format(spread.stdev)}`;
}

/**
 * The headline sentence.
 *
 * It is allowed to say the thesis failed, and that is the entire reason it is computed
 * from `separated()` rather than from `>`. Cross-module recall is the number that matters,
 * and with a handful of runs two means can differ by pure noise; a scorecard that reports
 * any positive gap as a win would confirm the thesis whatever the data said, which would
 * make the whole exercise decorative.
 */
export function verdict(report: EvalReport): string {
  const grounded = report.overall.grounded.crossModuleRecall;
  const baseline = report.overall['diff-only'].crossModuleRecall;

  if (grounded.n === 0 || baseline.n === 0) {
    return 'INCONCLUSIVE — not enough completed runs to compare.';
  }

  const delta = grounded.mean - baseline.mean;
  const gap = `${PERCENT(grounded.mean)} vs ${PERCENT(baseline.mean)}`;

  if (!separated(grounded, baseline)) {
    return (
      `NO MEASURABLE DIFFERENCE in cross-module catch-rate (${gap}). The gap is smaller ` +
      `than the run-to-run spread, so it is not evidence either way.`
    );
  }

  if (delta > 0) {
    return (
      `Graph-grounded context caught ${PERCENT(delta)} MORE cross-module defects than the ` +
      `diff-only baseline (${gap}), same model, same prompt.`
    );
  }

  return (
    `Graph-grounded context caught ${PERCENT(-delta)} FEWER cross-module defects than the ` +
    `diff-only baseline (${gap}). The thesis is not supported by this run.`
  );
}

export function toMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  const overallGrounded = report.overall.grounded;
  const overallBaseline = report.overall['diff-only'];

  lines.push('# RippleReview eval scorecard');
  lines.push('');
  lines.push(`**${verdict(report)}**`);
  lines.push('');
  lines.push(
    `Provider \`${report.provider}\`, model \`${report.model}\`, ` +
      `${report.runsPerArm} run(s) per arm per case. ` +
      `Started ${report.startedAt}, finished ${report.finishedAt}.`,
  );
  lines.push('');

  if (report.provider === 'echo') {
    lines.push(
      '> ⚠️ **This run used the `echo` stub, not a language model.** It proves the harness ' +
        'executes end to end. Every number below is meaningless as a measure of review ' +
        'quality — the stub returns one fixed finding and has no opinion about code.',
    );
    lines.push('');
  }

  lines.push('## Overall');
  lines.push('');
  lines.push('| Metric | Graph-grounded | Diff-only baseline |');
  lines.push('|---|---|---|');
  lines.push(
    `| **Cross-module catch-rate** | ${spreadCell(overallGrounded.crossModuleRecall, PERCENT)} | ${spreadCell(overallBaseline.crossModuleRecall, PERCENT)} |`,
  );
  lines.push(
    `| Recall (all defects) | ${spreadCell(overallGrounded.recall, PERCENT)} | ${spreadCell(overallBaseline.recall, PERCENT)} |`,
  );
  lines.push(
    `| Precision | ${spreadCell(overallGrounded.precision, PERCENT)} | ${spreadCell(overallBaseline.precision, PERCENT)} |`,
  );
  lines.push(
    `| F1 | ${spreadCell(overallGrounded.f1, (v) => v.toFixed(2))} | ${spreadCell(overallBaseline.f1, (v) => v.toFixed(2))} |`,
  );
  lines.push(
    `| Prompt tokens | ${spreadCell(overallGrounded.promptTokens, (v) => Math.round(v).toString())} | ${spreadCell(overallBaseline.promptTokens, (v) => Math.round(v).toString())} |`,
  );
  lines.push(
    `| Model latency | ${spreadCell(overallGrounded.latencyMs, (v) => `${Math.round(v)}ms`)} | ${spreadCell(overallBaseline.latencyMs, (v) => `${Math.round(v)}ms`)} |`,
  );
  lines.push(
    `| Failed runs | ${overallGrounded.failures} | ${overallBaseline.failures} |`,
  );
  lines.push('');
  lines.push(
    '`±` is the population standard deviation across runs. Where two means differ by less ' +
      'than the combined spread, the difference is not reported as a result.',
  );
  lines.push('');

  lines.push('## By case');
  lines.push('');
  for (const entry of report.cases) {
    lines.push(`### ${entry.case}`);
    lines.push('');
    lines.push(entry.summary);
    lines.push('');
    lines.push(`${entry.defectCount} planted defect(s).`);
    lines.push('');
    lines.push('| Metric | Graph-grounded | Diff-only |');
    lines.push('|---|---|---|');
    lines.push(
      `| Recall | ${spreadCell(entry.arms.grounded.recall, PERCENT)} | ${spreadCell(entry.arms['diff-only'].recall, PERCENT)} |`,
    );
    lines.push(
      `| Precision | ${spreadCell(entry.arms.grounded.precision, PERCENT)} | ${spreadCell(entry.arms['diff-only'].precision, PERCENT)} |`,
    );
    lines.push(
      `| Prompt tokens | ${spreadCell(entry.arms.grounded.promptTokens, (v) => Math.round(v).toString())} | ${spreadCell(entry.arms['diff-only'].promptTokens, (v) => Math.round(v).toString())} |`,
    );
    lines.push('');

    const missedByBoth = missedEverywhere(entry);
    if (missedByBoth.length > 0) {
      lines.push(`Missed by **both** arms in every run: ${missedByBoth.join(', ')}.`);
      lines.push('');
    }
  }

  lines.push('## How a finding is credited');
  lines.push('');
  lines.push(
    'A finding counts as identifying a planted defect when it names the same file, lands ' +
      'within that defect\'s line tolerance, and carries a category the defect accepts. ' +
      'Several findings identifying one defect credit it once; the extras are counted as ' +
      'neither hits nor false positives. No language model is involved in scoring.',
  );
  lines.push('');

  return lines.join('\n');
}

function missedEverywhere(entry: EvalReport['cases'][number]): string[] {
  if (entry.runs.length === 0) return [];
  const everCaught = new Set(entry.runs.flatMap((run) => run.match.caught));
  const allDefects = new Set(entry.runs.flatMap((run) => [...run.match.caught, ...run.match.missed]));
  return [...allDefects].filter((id) => !everCaught.has(id));
}

/**
 * A dependency-free SVG bar chart of the headline metric.
 *
 * Hand-drawn rather than pulled from a charting library: it is two bars, and a chart
 * dependency would be several megabytes to render a rectangle.
 */
export function toSvg(report: EvalReport): string {
  const grounded = report.overall.grounded.crossModuleRecall;
  const baseline = report.overall['diff-only'].crossModuleRecall;

  const width = 520;
  const height = 260;
  const barMaxWidth = 300;
  const labelX = 190;

  const bar = (y: number, value: number, colour: string, label: string): string => {
    const w = Math.max(2, Math.round(value * barMaxWidth));
    return [
      `<text x="${labelX - 12}" y="${y + 18}" text-anchor="end" font-size="14" fill="#333">${label}</text>`,
      `<rect x="${labelX}" y="${y}" width="${w}" height="26" fill="${colour}" rx="3" />`,
      `<text x="${labelX + w + 8}" y="${y + 18}" font-size="14" fill="#333">${(value * 100).toFixed(1)}%</text>`,
    ].join('\n  ');
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">
  <rect width="${width}" height="${height}" fill="#fff" />
  <text x="20" y="34" font-size="17" font-weight="600" fill="#111">Cross-module defect catch-rate</text>
  <text x="20" y="56" font-size="12" fill="#666">${escapeXml(report.provider)} / ${escapeXml(report.model)} — ${report.runsPerArm} run(s) per arm</text>
  ${bar(90, grounded.mean, '#2563eb', 'Graph-grounded')}
  ${bar(140, baseline.mean, '#9ca3af', 'Diff-only')}
  <line x1="${labelX}" y1="80" x2="${labelX}" y2="180" stroke="#e5e7eb" />
  <text x="20" y="222" font-size="12" fill="#666">${escapeXml(verdict(report).slice(0, 72))}</text>
</svg>
`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
