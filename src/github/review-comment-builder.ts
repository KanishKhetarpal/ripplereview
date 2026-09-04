import { Injectable } from '@nestjs/common';
import { changedLineNumbers } from '../ingest/diff-parser';
import { ChangedFile } from '../ingest/interfaces/change-set.interface';
import { Finding, SEVERITY_ORDER, Severity } from '../core/types/finding';
import { ReviewResult } from '../core/types/review-result';

export interface InlineComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface PullRequestReview {
  summary: string;
  inline: InlineComment[];
  /** Findings that could not be placed inline, and are therefore in the summary. */
  offDiffCount: number;
}

const SEVERITY_ICON: Record<Severity, string> = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🔵',
  info: '⚪',
};

@Injectable()
export class ReviewCommentBuilder {
  /**
   * Splits findings into inline comments and a summary.
   *
   * The split is forced by GitHub and it lands squarely on this product's whole point.
   * A pull request review comment can only be attached to a line that appears in the diff;
   * anything else is rejected outright. But the findings that justify this tool are
   * precisely the ones about files the diff never mentions — the caller two modules away
   * that silently keeps compiling.
   *
   * So the blast-radius findings, the valuable ones, can never be inline. They go in the
   * summary under their own heading, with the evidence that produced them. Attempting to
   * post them inline would fail the entire review request, taking the placeable comments
   * down with them.
   */
  build(result: ReviewResult, changedFiles: ChangedFile[]): PullRequestReview {
    const commentable = commentableLines(changedFiles);

    const inline: InlineComment[] = [];
    const offDiff: Finding[] = [];

    for (const finding of sortBySeverity(result.findings)) {
      const lines = commentable.get(normalise(finding.file));

      if (finding.line > 0 && lines?.has(finding.line)) {
        inline.push({
          path: normalise(finding.file),
          line: finding.line,
          side: 'RIGHT',
          body: inlineBody(finding),
        });
        continue;
      }

      offDiff.push(finding);
    }

    return {
      summary: this.summary(result, offDiff),
      inline,
      offDiffCount: offDiff.length,
    };
  }

  private summary(result: ReviewResult, offDiff: Finding[]): string {
    const lines: string[] = [];

    lines.push('## RippleReview');
    lines.push('');

    if (!result.graphGrounded) {
      lines.push(
        '> Ran **diff-only**: the dependency graph was not consulted, so nothing below ' +
          'accounts for what this change reaches.',
      );
      lines.push('');
    }

    lines.push(...this.blastRadiusSection(result));

    if (offDiff.length > 0) {
      lines.push(`### ${offDiff.length} finding(s) outside the diff`);
      lines.push('');
      lines.push(
        'GitHub only accepts an inline comment on a line the diff touches. These are ' +
          'about code this change *reaches* rather than code it edits — which is exactly ' +
          'what a diff-only reviewer cannot see.',
      );
      lines.push('');
      for (const finding of offDiff) {
        lines.push(
          `- ${SEVERITY_ICON[finding.severity]} **${finding.severity}** ` +
            `\`${finding.file}${finding.line > 0 ? `:${finding.line}` : ''}\` — ${finding.summary}`,
        );
        lines.push(`  ${finding.rationale}`);
        if (finding.evidenceRefs.length > 0) {
          lines.push(`  <sub>evidence: ${finding.evidenceRefs.join(', ')}</sub>`);
        }
      }
      lines.push('');
    }

    if (result.findings.length === 0) {
      lines.push('No findings.');
      lines.push('');
    }

    lines.push(...this.evidenceSection(result));

    if (result.rejected.length > 0) {
      // Shown, not hidden. A guard whose rejections are invisible cannot be told from one
      // that never fires, and a reviewer deserves to know the tool suppressed something.
      lines.push(
        `<sub>${result.rejected.length} finding(s) were dropped as ungrounded: they made ` +
          'structural claims the dependency graph did not support.</sub>',
      );
      lines.push('');
    }

    lines.push(
      `<sub>${result.llm.provider}/${result.llm.model} · ` +
        `${result.totalDurationMs}ms · run \`${result.runId}\`</sub>`,
    );

    return lines.join('\n');
  }

  private blastRadiusSection(result: ReviewResult): string[] {
    const impact = result.impact;
    if (!impact) return [];

    const lines: string[] = ['### Blast radius', ''];
    lines.push(
      `\`${impact.changedSymbols.length}\` changed symbol(s) reach ` +
        `\`${impact.impactedSites.length}\` site(s) within ${impact.stats.hopLimit} hop(s), ` +
        `across ${impact.stats.moduleCount} modules.`,
    );
    lines.push('');

    const cycles = impact.cycles.filter((cycle) => cycle.introducedByChange);
    for (const cycle of cycles) {
      lines.push(`- ⚠️ **Introduces a dependency cycle**: \`${cycle.nodeIds.join(' → ')}\``);
    }

    const violations = impact.layerViolations.filter((v) => v.introducedByChange);
    for (const violation of violations) {
      lines.push(
        `- ⚠️ **Breaks an architecture rule**: \`${violation.fromModule}\` → ` +
          `\`${violation.toModule}\` (\`${violation.rule}\`)`,
      );
    }

    if (impact.unanalysedFiles.length > 0) {
      lines.push(
        `- ℹ️ ${impact.unanalysedFiles.length} changed source file(s) were outside the ` +
          'parsed project, so the blast radius below is a lower bound.',
      );
    }

    if (cycles.length > 0 || violations.length > 0 || impact.unanalysedFiles.length > 0) {
      lines.push('');
    }

    return lines;
  }

  private evidenceSection(result: ReviewResult): string[] {
    if (result.evidence.length === 0) return [];

    const lines: string[] = [];
    lines.push('<details><summary>Evidence the review was grounded in</summary>');
    lines.push('');
    lines.push('| id | kind | fact |');
    lines.push('|---|---|---|');
    for (const item of result.evidence.slice(0, 25)) {
      lines.push(`| \`${item.id}\` | ${item.kind} | ${escapePipes(item.summary)} |`);
    }
    if (result.evidence.length > 25) {
      lines.push(`| | | …and ${result.evidence.length - 25} more |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
    return lines;
  }
}

function inlineBody(finding: Finding): string {
  const parts = [
    `${SEVERITY_ICON[finding.severity]} **${finding.severity}** · ${finding.category}`,
    '',
    `**${finding.summary}**`,
    '',
    finding.rationale,
  ];
  if (finding.evidenceRefs.length > 0) {
    parts.push('', `<sub>evidence: ${finding.evidenceRefs.join(', ')}</sub>`);
  }
  return parts.join('\n');
}

/**
 * The lines GitHub will accept a comment on: the new side of every hunk.
 *
 * Taken from the diff this tool already parsed rather than from a second call to
 * `GET /pulls/:n/files`. The parser produces exactly this set, and asking GitHub for its
 * own copy would introduce a way for the two to disagree about which lines exist.
 */
export function commentableLines(files: ChangedFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.status === 'deleted') continue;
    map.set(normalise(file.path), new Set(changedLineNumbers(file)));
  }
  return map;
}

function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}
