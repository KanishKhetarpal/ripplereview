import { ChangeImpact } from '../core/types/change-impact';
import { Finding } from '../core/types/finding';
import { ReviewResult } from '../core/types/review-result';
import { StoredRunSummary } from '../db/run-store.service';
import { renderBlastRadiusSvg } from './blast-radius-svg';
import { escapeHtml } from './escape-html';

/**
 * Server-rendered HTML. No bundler, no framework, no client-side JavaScript at all.
 *
 * The dashboard's job is to show what a stored run found; every byte of that is known on
 * the server. Adding a build step and a runtime to re-fetch it in the browser would buy
 * nothing and would put a second toolchain between a change here and seeing it.
 */

const STYLES = `
:root { color-scheme: light dark; --bg:#fbfbfd; --fg:#16181d; --muted:#6b7280; --line:#e4e6eb;
  --card:#fff; --accent:#2f6feb; --changed:#2f6feb; --impacted:#8a8f98;
  --critical:#b3261e; --high:#c2410c; --medium:#a16207; --low:#4b5563; --info:#6b7280; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1115; --fg:#e6e8ec; --muted:#9aa1ac; --line:#262a33; --card:#151922;
    --accent:#6d9bff; --changed:#6d9bff; --impacted:#79808c;
    --critical:#ff6b60; --high:#ff9f5a; --medium:#e0b341; --low:#9aa1ac; --info:#9aa1ac; }
}
* { box-sizing: border-box; }
body { margin:0; padding:32px; background:var(--bg); color:var(--fg);
  font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size:20px; margin:0 0 4px; letter-spacing:-0.01em; }
h2 { font-size:15px; margin:32px 0 12px; text-transform:uppercase; letter-spacing:0.08em;
  color:var(--muted); font-weight:600; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.sub { color:var(--muted); font-size:13px; margin:0 0 24px; }
code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size:12.5px; }
table { width:100%; border-collapse:collapse; }
th { text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:0.06em;
  color:var(--muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); }
td { padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }
tr:last-child td { border-bottom:none; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px;
  padding:16px 18px; margin-bottom:12px; }
.finding-head { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
.sev { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
.sev-critical{color:var(--critical)} .sev-high{color:var(--high)} .sev-medium{color:var(--medium)}
.sev-low{color:var(--low)} .sev-info{color:var(--info)}
.tag { font-size:11px; color:var(--muted); border:1px solid var(--line);
  border-radius:999px; padding:1px 8px; }
.rationale { margin:8px 0 0; white-space:pre-wrap; }
.refs { margin-top:8px; font-size:12px; color:var(--muted); }
.empty { color:var(--muted); font-style:italic; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px;
  background:var(--card); padding:8px; }
.note { color:var(--muted); font-size:12.5px; margin-top:8px; }
.blast-radius .node rect { fill:var(--card); stroke:var(--impacted); stroke-width:1.25; }
.blast-radius .node.changed rect { stroke:var(--changed); stroke-width:2; }
.blast-radius .node-title { fill:var(--fg); font:600 13px ui-sans-serif, system-ui, sans-serif; }
.blast-radius .node-subtitle { fill:var(--muted); font:11px ui-monospace, Menlo, monospace; }
.blast-radius .col-header { fill:var(--muted); font:600 11px ui-sans-serif, system-ui, sans-serif;
  text-transform:uppercase; letter-spacing:0.08em; }
.blast-radius .overflow { fill:var(--muted); font:11px ui-sans-serif, system-ui, sans-serif; }
.blast-radius .empty { fill:var(--muted); font:13px ui-sans-serif, system-ui, sans-serif; }
.blast-radius .edge { fill:none; stroke:var(--impacted); stroke-width:1.25; opacity:0.75; }
.blast-radius .edge.hop-2, .blast-radius .edge.hop-3 { stroke-dasharray:4 3; opacity:0.55; }
.blast-radius .arrow-head { fill:var(--impacted); }
`;

export function layout(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    '</head><body><main>',
    body,
    '</main></body></html>',
  ].join('');
}

/** Shown instead of an error when no database is configured. */
export function renderPersistenceOff(): string {
  return layout(
    'RippleReview — dashboard',
    [
      '<h1>RippleReview</h1>',
      '<p class="sub">Run history</p>',
      '<div class="card">',
      '<p>No runs are being stored, so there is no history to show.</p>',
      '<p class="note">Set <code>DATABASE_URL</code> to a PostgreSQL connection string and ',
      'reviews will be filed as they run. Reviews work without it; only the history does not.</p>',
      '</div>',
    ].join(''),
  );
}

export function renderRunList(runs: StoredRunSummary[]): string {
  const rows = runs
    .map(
      (run) => `<tr>
        <td><a href="runs/${encodeURIComponent(run.runId)}">${escapeHtml(shortId(run.runId))}</a>
          <div class="mono" style="color:var(--muted)">${escapeHtml(run.createdAt)}</div></td>
        <td class="mono">${escapeHtml(run.baseRef)} → ${escapeHtml(run.headRef)}
          <div style="color:var(--muted)">${escapeHtml(run.repoRoot)}</div></td>
        <td>${run.graphGrounded ? 'grounded' : '<span class="empty">diff-only</span>'}</td>
        <td>${run.findingsCount}${run.rejectedCount > 0 ? ` <span class="empty">(${run.rejectedCount} dropped)</span>` : ''}</td>
        <td class="mono">${escapeHtml(run.provider)}/${escapeHtml(run.model)}</td>
        <td class="mono">${run.totalDurationMs} ms</td>
      </tr>`,
    )
    .join('');

  const body = runs.length
    ? `<div class="scroll"><table>
         <thead><tr><th>Run</th><th>Range</th><th>Arm</th><th>Findings</th><th>Model</th><th>Duration</th></tr></thead>
         <tbody>${rows}</tbody></table></div>`
    : '<div class="card"><p class="empty">No runs recorded yet.</p></div>';

  return layout(
    'RippleReview — runs',
    `<h1>RippleReview</h1><p class="sub">${runs.length} stored run${runs.length === 1 ? '' : 's'}, newest first</p>${body}`,
  );
}

export function renderRunDetail(result: ReviewResult): string {
  const sections = [
    `<h1>${escapeHtml(result.repo.baseRef)} → ${escapeHtml(result.repo.headRef)}</h1>`,
    `<p class="sub"><a href="../">← all runs</a> &nbsp;·&nbsp; ${escapeHtml(result.repo.root)}
      &nbsp;·&nbsp; ${escapeHtml(result.createdAt)}
      &nbsp;·&nbsp; ${escapeHtml(result.llm.provider)}/${escapeHtml(result.llm.model)}
      &nbsp;·&nbsp; ${result.totalDurationMs} ms
      &nbsp;·&nbsp; ${result.graphGrounded ? 'graph-grounded' : 'diff-only baseline'}</p>`,
    renderBlastRadius(result.impact),
    renderFindings(result.findings),
    renderRejected(result),
    renderDuplicates(result.impact),
    renderEvidence(result),
  ];

  return layout(`RippleReview — ${shortId(result.runId)}`, sections.join(''));
}

function renderBlastRadius(impact: ChangeImpact | null): string {
  if (!impact) {
    return (
      '<h2>Blast radius</h2><div class="card"><p class="empty">This was a diff-only run: ' +
      'the graph engine was never invoked, so there is no blast radius to draw.</p></div>'
    );
  }

  return [
    '<h2>Blast radius</h2>',
    `<div class="scroll">${renderBlastRadiusSvg(impact)}</div>`,
    // Said in words because the picture cannot say it. The impact model records the origin
    // and the distance, never the symbols in between, so a two-hop arrow is a statement
    // about reachability rather than a call.
    `<p class="note">${impact.changedSymbols.length} changed symbol(s) reaching
      ${impact.impactedSites.length} site(s) within ${impact.stats.hopLimit} hops.
      An arrow means "reaches, at this distance" — the intermediate symbols are not
      recorded, so a two-hop arrow is not a direct call.</p>`,
    impact.unanalysedFiles.length > 0
      ? `<p class="note">${impact.unanalysedFiles.length} changed file(s) were outside the parsed
         project, so this is a lower bound: ${escapeHtml(impact.unanalysedFiles.slice(0, 5).join(', '))}</p>`
      : '',
  ].join('');
}

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return '<h2>Findings</h2><div class="card"><p class="empty">No findings.</p></div>';
  }

  const cards = findings
    .map(
      (finding) => `<div class="card">
        <div class="finding-head">
          <span class="sev sev-${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <span class="tag">${escapeHtml(finding.category)}</span>
          <strong>${escapeHtml(finding.summary)}</strong>
        </div>
        <div class="mono" style="color:var(--muted);margin-top:4px">${escapeHtml(finding.file)}${
          finding.line > 0 ? `:${finding.line}` : ' (whole change)'
        }</div>
        <p class="rationale">${escapeHtml(finding.rationale)}</p>
        ${
          finding.evidenceRefs.length
            ? `<div class="refs">cites ${escapeHtml(finding.evidenceRefs.join(', '))}</div>`
            : '<div class="refs">no citation — a local observation about the diff</div>'
        }
      </div>`,
    )
    .join('');

  return `<h2>Findings (${findings.length})</h2>${cards}`;
}

/**
 * What the grounding guard threw away, shown rather than hidden.
 *
 * A guard whose rejections are invisible cannot be told from one that never fires, and the
 * rejections are the most direct evidence the project's central claim is being enforced.
 */
function renderRejected(result: ReviewResult): string {
  if (result.rejected.length === 0) return '';

  const cards = result.rejected
    .map(
      (rejection) => `<div class="card">
        <div class="finding-head">
          <span class="tag">${escapeHtml(rejection.reason)}</span>
          <strong>${escapeHtml(rejection.finding.summary)}</strong>
        </div>
        <p class="note">${escapeHtml(rejection.detail)}</p>
      </div>`,
    )
    .join('');

  return `<h2>Dropped as ungrounded (${result.rejected.length})</h2>${cards}`;
}

function renderDuplicates(impact: ChangeImpact | null): string {
  if (!impact || impact.duplicates.length === 0) return '';

  const rows = impact.duplicates
    .map(
      (match) => `<tr>
        <td class="mono">${match.similarity.toFixed(2)}</td>
        <td class="mono">${escapeHtml(match.name)}<div style="color:var(--muted)">${escapeHtml(match.file)}:${match.line}</div></td>
        <td class="mono">${escapeHtml(match.duplicateOf.name)}<div style="color:var(--muted)">${escapeHtml(
          match.duplicateOf.file,
        )}:${match.duplicateOf.line}${
          match.duplicateOf.repo ? ` — ${escapeHtml(match.duplicateOf.repo)}` : ''
        }</div></td>
      </tr>`,
    )
    .join('');

  return `<h2>Duplicate logic (${impact.duplicates.length})</h2>
    <div class="scroll"><table>
      <thead><tr><th>Similarity</th><th>Changed</th><th>Already exists</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="note">Structural comparison: local names and literal values are abstracted,
      called methods are not. 1.00 means the two bodies normalise identically.</p>`;
}

function renderEvidence(result: ReviewResult): string {
  if (result.evidence.length === 0) return '';

  const rows = result.evidence
    .map(
      (item) => `<tr>
        <td class="mono">${escapeHtml(item.id)}</td>
        <td><span class="tag">${escapeHtml(item.kind)}</span></td>
        <td>${escapeHtml(item.summary)}</td>
      </tr>`,
    )
    .join('');

  return `<h2>Evidence (${result.evidence.length})</h2>
    <div class="scroll"><table>
      <thead><tr><th>Id</th><th>Kind</th><th>Fact</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function shortId(runId: string): string {
  return runId.slice(0, 8);
}

export { STYLES };
