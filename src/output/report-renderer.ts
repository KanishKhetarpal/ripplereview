import { Injectable } from '@nestjs/common';
import { Finding, SEVERITY_ORDER, Severity } from '../core/types/finding';
import { ReviewResult } from '../core/types/review-result';

const ESC = '\u001b';

const ANSI: Record<string, string> = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  gray: `${ESC}[90m`,
};

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'magenta',
  high: 'red',
  medium: 'yellow',
  low: 'blue',
  info: 'gray',
};

export interface RenderOptions {
  color: boolean;
}

@Injectable()
export class ReportRenderer {
  renderJson(result: ReviewResult): string {
    return JSON.stringify(result, null, 2);
  }

  renderText(result: ReviewResult, options: RenderOptions): string {
    const paint = (name: string, text: string): string =>
      options.color ? `${ANSI[name]}${text}${ANSI.reset}` : text;

    const lines: string[] = [];
    lines.push(paint('bold', 'RippleReview'));
    lines.push(paint('dim', `${result.repo.baseRef}..${result.repo.headRef}  ${result.repo.root}`));
    lines.push(
      paint(
        'dim',
        `${result.graphGrounded ? 'graph-grounded' : 'DIFF-ONLY (no graph context)'}  |  ` +
          `${result.llm.provider}/${result.llm.model}  |  ${result.totalDurationMs}ms`,
      ),
    );
    lines.push('');

    if (result.impact) {
      lines.push(...this.renderImpact(result, paint));
    }

    if (result.findings.length === 0) {
      lines.push(paint('dim', 'No findings.'));
      lines.push('');
    } else {
      lines.push(paint('bold', `Findings (${result.findings.length})`));
      lines.push('');
      for (const finding of this.sortBySeverity(result.findings)) {
        const badge = paint(SEVERITY_COLOR[finding.severity], finding.severity.toUpperCase());
        const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
        lines.push(`  ${badge}  ${paint('bold', finding.summary)}`);
        lines.push(`    ${paint('dim', `${where}  |  ${finding.category}`)}`);
        lines.push(`    ${finding.rationale}`);
        if (finding.evidenceRefs.length > 0) {
          lines.push(`    ${paint('dim', `evidence: ${finding.evidenceRefs.join(', ')}`)}`);
        }
        lines.push('');
      }
    }

    if (result.rejected.length > 0) {
      lines.push(paint('yellow', `Dropped as ungrounded (${result.rejected.length})`));
      for (const rejection of result.rejected) {
        lines.push(`  ${rejection.finding.summary}`);
        lines.push(`    ${paint('dim', `${rejection.reason}: ${rejection.detail}`)}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private renderImpact(
    result: ReviewResult,
    paint: (name: string, text: string) => string,
  ): string[] {
    const impact = result.impact;
    if (!impact) return [];

    const lines: string[] = [paint('bold', 'Blast radius')];
    lines.push(
      `  ${impact.changedSymbols.length} changed symbol(s) across ` +
        `${impact.changedFiles.length} file(s)`,
    );
    lines.push(
      `  ${impact.impactedSites.length} impacted site(s) within ${impact.stats.hopLimit} hop(s)`,
    );

    const introducedCycles = impact.cycles.filter((cycle) => cycle.introducedByChange);
    if (introducedCycles.length > 0) {
      lines.push(paint('red', `  ${introducedCycles.length} circular dependency introduced`));
    }

    const introducedViolations = impact.layerViolations.filter((v) => v.introducedByChange);
    if (introducedViolations.length > 0) {
      lines.push(paint('red', `  ${introducedViolations.length} layering violation introduced`));
    }

    lines.push('');
    return lines;
  }

  private sortBySeverity(findings: Finding[]): Finding[] {
    return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }
}
