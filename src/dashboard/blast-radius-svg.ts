import { ChangeImpact, ImpactedSite } from '../core/types/change-impact';
import { escapeHtml } from './escape-html';

/**
 * The blast radius drawn as inline SVG, generated on the server.
 *
 * No client-side charting library and no CDN script, which is a deliberate choice rather
 * than a limitation. A dashboard that renders nothing without a network round trip to
 * someone else's CDN is a dashboard that fails exactly when it is most wanted — offline,
 * inside a private network, or on a machine with no outbound internet. It also makes the
 * output testable: what the page contains can be asserted directly instead of after
 * executing a bundle in a headless browser.
 */

const NODE_WIDTH = 230;
const NODE_HEIGHT = 46;
const COLUMN_GAP = 96;
const ROW_GAP = 14;
const PADDING = 28;
const HEADER_HEIGHT = 34;

/**
 * Nodes drawn per column before the rest are summarised.
 *
 * A change touching a widely-used utility can reach hundreds of sites. Drawing all of them
 * produces an image tens of thousands of pixels tall that nobody scrolls, so the column is
 * capped and the remainder is stated — the same treatment the terminal renderer gives.
 */
const MAX_PER_COLUMN = 10;

export interface BlastRadiusSvgOptions {
  maxPerColumn?: number;
}

interface Placed {
  x: number;
  y: number;
  id: string;
}

export function renderBlastRadiusSvg(
  impact: ChangeImpact,
  options: BlastRadiusSvgOptions = {},
): string {
  const cap = options.maxPerColumn ?? MAX_PER_COLUMN;

  if (impact.changedSymbols.length === 0) {
    return emptyDiagram('No changed symbols were resolved for this run.');
  }

  const columns = buildColumns(impact, cap);
  const rows = Math.max(...columns.map((column) => column.entries.length));
  const width = PADDING * 2 + columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP;
  const height =
    PADDING * 2 + HEADER_HEIGHT + rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP + 24;

  const placed = new Map<string, Placed>();
  const nodes: string[] = [];
  const headers: string[] = [];

  columns.forEach((column, columnIndex) => {
    const x = PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP);
    headers.push(
      `<text class="col-header" x="${x}" y="${PADDING + 12}">${escapeHtml(column.label)}</text>`,
    );

    column.entries.forEach((entry, rowIndex) => {
      const y = PADDING + HEADER_HEIGHT + rowIndex * (NODE_HEIGHT + ROW_GAP);
      placed.set(entry.id, { x, y, id: entry.id });
      nodes.push(node(x, y, entry.title, entry.subtitle, columnIndex === 0));
    });

    if (column.overflow > 0) {
      const y = PADDING + HEADER_HEIGHT + column.entries.length * (NODE_HEIGHT + ROW_GAP);
      nodes.push(
        `<text class="overflow" x="${x + 8}" y="${y + 16}">+ ${column.overflow} more not drawn</text>`,
      );
    }
  });

  // Edges last in document order so they paint over nothing; SVG has no z-index, so the
  // only control over stacking is the order elements appear in.
  const edges = buildEdges(impact, placed);

  return [
    `<svg class="blast-radius" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"`,
    ' xmlns="http://www.w3.org/2000/svg" role="img"',
    ` aria-label="Blast radius: ${impact.changedSymbols.length} changed symbol(s) reaching ${impact.impactedSites.length} site(s)">`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"',
    ' markerHeight="6" orient="auto-start-reverse">',
    '<path class="arrow-head" d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>',
    edges.join(''),
    headers.join(''),
    nodes.join(''),
    '</svg>',
  ].join('');
}

interface ColumnEntry {
  id: string;
  title: string;
  subtitle: string;
}

interface Column {
  label: string;
  entries: ColumnEntry[];
  overflow: number;
}

/**
 * One column per hop distance: the change itself, then what is one hop away, and so on.
 *
 * Hop distance is the axis that matters. A direct caller is what breaks first, and laying
 * the graph out by distance says that at a glance in a way a force-directed blob cannot.
 */
function buildColumns(impact: ChangeImpact, cap: number): Column[] {
  const changed: Column = {
    label: 'Changed',
    entries: impact.changedSymbols.slice(0, cap).map((symbol) => ({
      id: symbol.id,
      title: symbol.name,
      subtitle: `${symbol.file}:${symbol.line}`,
    })),
    overflow: Math.max(0, impact.changedSymbols.length - cap),
  };

  const byHop = new Map<number, ImpactedSite[]>();
  for (const site of impact.impactedSites) {
    byHop.set(site.hops, [...(byHop.get(site.hops) ?? []), site]);
  }

  const hopColumns = [...byHop.keys()]
    .sort((a, b) => a - b)
    .map((hop) => {
      // Highest fan-in first: among equally distant sites, the one in a module half the
      // codebase depends on is the one worth the space. Same ordering the evidence
      // builder ranks by, so the picture and the prompt agree about what matters.
      const sites = [...(byHop.get(hop) ?? [])].sort((a, b) => b.moduleFanIn - a.moduleFanIn);
      return {
        label: `${hop} hop${hop === 1 ? '' : 's'} away`,
        entries: sites.slice(0, cap).map((site) => ({
          id: `${site.symbolId}@${site.file}:${site.line}`,
          title: shortName(site.symbolId),
          subtitle: `${site.file}:${site.line}`,
        })),
        overflow: Math.max(0, sites.length - cap),
      };
    });

  return [changed, ...hopColumns];
}

/**
 * An edge from each drawn site back to the changed symbol it traces to.
 *
 * NOT a step-by-step path: `ImpactedSite` records the origin and the distance, never the
 * intermediate symbols, so a two-hop edge here is a claim about reachability and distance
 * and nothing more. A plain arrow from a distant site to the change would read as a direct
 * call, so the distance is carried two ways instead: the site's COLUMN, and a dashed line
 * for anything past one hop. The page states it in words as well, because neither of those
 * is self-explanatory.
 */
function buildEdges(impact: ChangeImpact, placed: Map<string, Placed>): string[] {
  const edges: string[] = [];

  for (const site of impact.impactedSites) {
    const from = placed.get(`${site.symbolId}@${site.file}:${site.line}`);
    const to = placed.get(site.viaSymbolId);
    // Either end may have been capped out of its column. An edge to a node that is not
    // drawn would be a line into empty space.
    if (!from || !to) continue;

    const x1 = from.x;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x + NODE_WIDTH;
    const y2 = to.y + NODE_HEIGHT / 2;
    const midX = (x1 + x2) / 2;

    edges.push(
      `<path class="edge hop-${site.hops}" d="M ${x2} ${y2} C ${midX} ${y2}, ${midX} ${y1}, ${x1} ${y1}" marker-end="url(#arrow)" />`,
    );
  }

  return edges;
}

function node(x: number, y: number, title: string, subtitle: string, isChanged: boolean): string {
  return [
    `<g class="node ${isChanged ? 'changed' : 'impacted'}">`,
    `<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="6" />`,
    `<text class="node-title" x="${x + 12}" y="${y + 20}">${escapeHtml(truncate(title, 30))}</text>`,
    `<text class="node-subtitle" x="${x + 12}" y="${y + 36}">${escapeHtml(truncate(subtitle, 34))}</text>`,
    '</g>',
  ].join('');
}

function emptyDiagram(message: string): string {
  return (
    '<svg class="blast-radius" viewBox="0 0 620 80" width="620" height="80" ' +
    'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="No blast radius to draw">' +
    `<text class="empty" x="12" y="44">${escapeHtml(message)}</text></svg>`
  );
}

/** SVG text does not wrap or clip, so an over-long label runs across its neighbours. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function shortName(symbolId: string): string {
  const hash = symbolId.indexOf('#');
  return hash === -1 ? symbolId : symbolId.slice(hash + 1);
}

export { MAX_PER_COLUMN };
