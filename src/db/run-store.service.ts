import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { ChangeImpact } from '../core/types/change-impact';
import { Finding } from '../core/types/finding';
import { ReviewResult } from '../core/types/review-result';
import { RejectedFinding } from '../core/grounding';

export const PG_POOL = Symbol('PG_POOL');

export interface StoredRunSummary {
  runId: string;
  createdAt: string;
  repoRoot: string;
  baseRef: string;
  headRef: string;
  graphGrounded: boolean;
  provider: string;
  model: string;
  findingsCount: number;
  rejectedCount: number;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
}

/**
 * Persists review runs, and does nothing at all when no database is configured.
 *
 * Optional on purpose. Someone running `ripplereview review` on a laptop should not need
 * Postgres, and a review that succeeded but could not be filed is still a review — so a
 * storage failure is logged and swallowed rather than thrown. The one place that would be
 * wrong is reading a run back, which reports honestly that persistence is off instead of
 * pretending the run does not exist.
 */
@Injectable()
export class RunStoreService {
  private readonly logger = new Logger(RunStoreService.name);

  constructor(@Optional() @Inject(PG_POOL) private readonly pool: Pool | null) {}

  get enabled(): boolean {
    return this.pool !== null;
  }

  /**
   * Files one run.
   *
   * Returns whether it was stored, and never throws: a database that is down must not turn
   * a completed review into a failed command. The caller has already paid for the graph
   * analysis and the model call.
   */
  async save(result: ReviewResult): Promise<boolean> {
    if (!this.pool) return false;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const usage = result.llm.usage;
      const promptTokens = usage.reduce((sum, u) => sum + u.inputTokens, 0);
      const completionTokens = usage.reduce((sum, u) => sum + u.outputTokens, 0);
      // Summed only if every call reported one. A partial sum presented as a total is a
      // number that looks authoritative and is wrong.
      const costs = usage.map((u) => u.estimatedCostUsd);
      const cost = costs.every((c) => c !== null)
        ? costs.reduce<number>((sum, c) => sum + c, 0)
        : null;

      await client.query(
        `INSERT INTO runs (
           id, created_at, repo_root, base_ref, head_ref, graph_grounded, provider, model,
           prompt_tokens, completion_tokens, estimated_cost_usd, llm_latency_ms, attempts,
           total_duration_ms, findings_count, rejected_count
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          result.runId,
          result.createdAt,
          result.repo.root,
          result.repo.baseRef,
          result.repo.headRef,
          result.graphGrounded,
          result.llm.provider,
          result.llm.model,
          promptTokens,
          completionTokens,
          cost,
          result.llm.latencyMs,
          result.llm.attempts,
          result.totalDurationMs,
          result.findings.length,
          result.rejected.length,
        ],
      );

      for (const finding of result.findings) {
        await this.insertFinding(client, result.runId, finding, true, null);
      }
      for (const rejection of result.rejected) {
        await this.insertFinding(
          client,
          result.runId,
          rejection.finding,
          false,
          `${rejection.reason}: ${rejection.detail}`,
        );
      }

      if (result.impact) {
        await this.insertImpact(client, result.runId, result.impact);
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error(
        `run ${result.runId} was not stored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      client.release();
    }
  }

  /** Null when the run is unknown. Throws when persistence is off, which is a different thing. */
  async findRun(runId: string): Promise<ReviewResult | null> {
    if (!this.pool) throw new PersistenceDisabledError();

    const runs = await this.pool.query(`SELECT * FROM runs WHERE id = $1`, [runId]);
    if (runs.rowCount === 0) return null;

    const row = runs.rows[0] as Record<string, unknown>;
    const findings = await this.pool.query(`SELECT * FROM findings WHERE run_id = $1 ORDER BY id`, [
      runId,
    ]);
    const impact = await this.pool.query(`SELECT impact FROM impact_snapshots WHERE run_id = $1`, [
      runId,
    ]);

    const kept: Finding[] = [];
    const rejected: RejectedFinding[] = [];

    for (const raw of findings.rows as Record<string, unknown>[]) {
      const finding = toFinding(raw);
      if (raw.grounded === true) {
        kept.push(finding);
        continue;
      }
      // A text column, but typed unknown until narrowed. String() on an object would give
      // "[object Object]" and the rejection reason would read as gibberish.
      const reason = typeof raw.rejection_reason === 'string' ? raw.rejection_reason : '';
      const [kind, ...rest] = reason.split(': ');
      rejected.push({
        finding,
        reason:
          kind === 'unknown-evidence-ref' ? 'unknown-evidence-ref' : 'uncited-structural-claim',
        detail: rest.join(': '),
      });
    }

    return {
      runId: String(row.id),
      createdAt: new Date(row.created_at as string).toISOString(),
      repo: {
        root: String(row.repo_root),
        baseRef: String(row.base_ref),
        headRef: String(row.head_ref),
      },
      graphGrounded: row.graph_grounded === true,
      findings: kept,
      rejected,
      // Evidence is not stored: it is derivable from the impact snapshot, and keeping a
      // second copy invites the two disagreeing.
      evidence: [],
      impact: impact.rowCount === 0 ? null : (impact.rows[0] as { impact: ChangeImpact }).impact,
      llm: {
        provider: String(row.provider),
        model: String(row.model),
        usage: [
          {
            inputTokens: Number(row.prompt_tokens),
            outputTokens: Number(row.completion_tokens),
            estimatedCostUsd:
              row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
          },
        ],
        latencyMs: Number(row.llm_latency_ms),
        attempts: Number(row.attempts),
      },
      totalDurationMs: Number(row.total_duration_ms),
    };
  }

  async listRuns(limit = 50): Promise<StoredRunSummary[]> {
    if (!this.pool) throw new PersistenceDisabledError();

    const result = await this.pool.query(
      `SELECT id, created_at, repo_root, base_ref, head_ref, graph_grounded, provider, model,
              findings_count, rejected_count, prompt_tokens, completion_tokens, total_duration_ms
       FROM runs ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );

    return (result.rows as Record<string, unknown>[]).map((row) => ({
      runId: String(row.id),
      createdAt: new Date(row.created_at as string).toISOString(),
      repoRoot: String(row.repo_root),
      baseRef: String(row.base_ref),
      headRef: String(row.head_ref),
      graphGrounded: row.graph_grounded === true,
      provider: String(row.provider),
      model: String(row.model),
      findingsCount: Number(row.findings_count),
      rejectedCount: Number(row.rejected_count),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalDurationMs: Number(row.total_duration_ms),
    }));
  }

  private async insertFinding(
    client: { query: (text: string, values: unknown[]) => Promise<unknown> },
    runId: string,
    finding: Finding,
    grounded: boolean,
    rejectionReason: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO findings (
         run_id, severity, category, file, line, summary, rationale, evidence_refs,
         confidence, grounded, rejection_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        runId,
        finding.severity,
        finding.category,
        finding.file,
        finding.line,
        finding.summary,
        finding.rationale,
        finding.evidenceRefs,
        finding.confidence ?? null,
        grounded,
        rejectionReason,
      ],
    );
  }

  private async insertImpact(
    client: { query: (text: string, values: unknown[]) => Promise<unknown> },
    runId: string,
    impact: ChangeImpact,
  ): Promise<void> {
    await client.query(
      `INSERT INTO impact_snapshots (
         run_id, hop_limit, module_count, edge_count, changed_symbol_count,
         impacted_site_count, warm_up_ms, lookup_ms, lookups, duration_ms, impact
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        runId,
        impact.stats.hopLimit,
        impact.stats.moduleCount,
        impact.stats.edgeCount,
        impact.changedSymbols.length,
        impact.stats.impactedSiteCount,
        impact.stats.warmUpMs,
        impact.stats.lookupMs,
        impact.stats.lookups,
        impact.stats.durationMs,
        JSON.stringify(impact),
      ],
    );
  }
}

export class PersistenceDisabledError extends Error {
  constructor() {
    super(
      'No database is configured, so no run was stored and none can be read back. Set ' +
        'DATABASE_URL to enable persistence.',
    );
    this.name = 'PersistenceDisabledError';
  }
}

function toFinding(row: Record<string, unknown>): Finding {
  return {
    severity: row.severity as Finding['severity'],
    category: row.category as Finding['category'],
    file: String(row.file),
    line: Number(row.line),
    summary: String(row.summary),
    rationale: String(row.rationale),
    evidenceRefs: (row.evidence_refs as string[] | null) ?? [],
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
  };
}
