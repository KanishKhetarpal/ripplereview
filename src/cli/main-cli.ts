#!/usr/bin/env node
import 'reflect-metadata';
import { Command, InvalidArgumentError } from 'commander';
import { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { ChangeImpact } from '../core/types/change-impact';
import { ReviewResult } from '../core/types/review-result';
import { ImpactRenderer } from '../output/impact-renderer';
import { ReportRenderer } from '../output/report-renderer';
import { ImpactService } from '../review/impact.service';
import { FailOn, blockingFindings } from '../review/severity-gate';
import { ReviewService } from '../review/review.service';

/**
 * Exit codes are part of the contract — CI reads them.
 *   0  the review ran and nothing blocking was found
 *   1  the review ran and reported blocking findings (wired with severity gating in Phase 4)
 *   2  the review could not run
 */
const EXIT_OK = 0;
const EXIT_BLOCKING_FINDINGS = 1;
const EXIT_ERROR = 2;

interface GlobalOptions {
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
}

async function withApp<T>(
  options: GlobalOptions,
  work: (ctx: {
    reviews: ReviewService;
    impacts: ImpactService;
    renderer: ReportRenderer;
    impactRenderer: ImpactRenderer;
    config: AppConfigService;
  }) => Promise<T>,
): Promise<T> {
  // JSON output must be the only thing on stdout, or a consumer piping it gets Nest's
  // bootstrap banner mixed into the payload.
  const logger: LogLevel[] = options.verbose
    ? ['error', 'warn', 'log', 'debug']
    : options.json
      ? ['error']
      : ['error', 'warn'];

  // Imported here, not at module scope: `@Module` decorators execute on require, and
  // ConfigModule validates the environment as they do. A static import would throw the
  // config error past this try/catch and out of the process as a stack trace.
  const { AppModule } = await import('../app.module');
  // abortOnError defaults to TRUE, which makes Nest log the failure itself and call
  // process.exit(1) — bypassing this function's caller and the documented exit codes.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger,
    abortOnError: false,
  });
  try {
    return await work({
      reviews: app.get(ReviewService),
      impacts: app.get(ImpactService),
      renderer: app.get(ReportRenderer),
      impactRenderer: app.get(ImpactRenderer),
      config: app.get(AppConfigService),
    });
  } finally {
    await app.close();
  }
}

function emit(result: ReviewResult, renderer: ReportRenderer, options: GlobalOptions): void {
  if (options.json) {
    process.stdout.write(`${renderer.renderJson(result)}\n`);
    return;
  }
  const color = options.color !== false && process.stdout.isTTY === true;
  process.stdout.write(`${renderer.renderText(result, { color })}\n`);
}

function emitImpact(impact: ChangeImpact, renderer: ImpactRenderer, options: GlobalOptions): void {
  if (options.json) {
    process.stdout.write(`${renderer.renderJson(impact)}
`);
    return;
  }
  const color = options.color !== false && process.stdout.isTTY === true;
  process.stdout.write(`${renderer.renderText(impact, { color })}
`);
}

function parseFailOn(value: string): FailOn {
  const allowed: FailOn[] = ['critical', 'high', 'medium', 'low', 'info', 'never'];
  if (!allowed.includes(value as FailOn)) {
    throw new InvalidArgumentError(`must be one of: ${allowed.join(', ')}`);
  }
  return value as FailOn;
}

/** Commander hands option values through as strings; a bad one must not become NaN. */
function parseHops(value: string): number {
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new InvalidArgumentError('must be a whole number between 1 and 10');
  }
  return hops;
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ripplereview: ${message}\n`);
  process.exit(EXIT_ERROR);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('ripplereview')
    .description('Graph-grounded AI code review: blast-radius context, not just a diff.')
    .version('0.1.0')
    .option('--json', 'emit machine-readable JSON on stdout')
    .option('--no-color', 'disable ANSI colour')
    .option('-v, --verbose', 'log pipeline progress to stderr');

  program
    .command('review')
    .argument('<repo>', 'path to the repository working tree')
    .option('--base <ref>', 'base git ref', 'HEAD~1')
    .option('--head <ref>', 'head git ref', 'HEAD')
    .option('--diff-only', 'skip the graph engine (the eval baseline)', false)
    .description('review the change between two refs')
    .option('--hops <n>', 'how far out to walk the blast radius', parseHops)
    .option(
      '--fail-on <severity>',
      'exit 1 when a finding is at or above this severity (default REVIEW_FAIL_ON)',
      parseFailOn,
    )
    .action(
      async (
        repo: string,
        cmd: { base: string; head: string; diffOnly: boolean; hops?: number; failOn?: FailOn },
      ) => {
        const globals = program.opts<GlobalOptions>();
        try {
          await withApp(globals, async ({ reviews, renderer, config }) => {
            const result = await reviews.run({
              repoPath: repo,
              baseRef: cmd.base,
              headRef: cmd.head,
              diffOnly: cmd.diffOnly,
              maxHops: cmd.hops,
            });
            emit(result, renderer, globals);

            const failOn: FailOn = cmd.failOn ?? config.failOn;
            const blocking = blockingFindings(result.findings, failOn);

            if (blocking.length > 0) {
              // Exit 1, not 2: the review RAN and found something. A build that cannot
              // tell "your code has a problem" from "the reviewer crashed" will end up
              // ignoring both.
              process.stderr.write(
                `
${blocking.length} finding(s) at or above "${failOn}" — failing.
`,
              );
              for (const finding of blocking) {
                process.stderr.write(
                  `  ${finding.severity}  ${finding.file}:${finding.line}  ${finding.summary}
`,
                );
              }
              process.exit(EXIT_BLOCKING_FINDINGS);
            }
          });
          process.exit(EXIT_OK);
        } catch (error) {
          fail(error);
        }
      },
    );

  program
    .command('impact')
    .argument('<repo>', 'path to the repository working tree')
    .option('--base <ref>', 'base git ref', 'HEAD~1')
    .option('--head <ref>', 'head git ref', 'HEAD')
    .option('--hops <n>', 'how far out to walk the blast radius', parseHops)
    .description('compute the blast radius of a change — the graph engine, no model')
    .action(async (repo: string, cmd: { base: string; head: string; hops?: number }) => {
      const globals = program.opts<GlobalOptions>();
      try {
        await withApp(globals, async ({ impacts, impactRenderer }) => {
          const impact = await impacts.compute({
            repoPath: repo,
            baseRef: cmd.base,
            headRef: cmd.head,
            maxHops: cmd.hops,
          });
          emitImpact(impact, impactRenderer, globals);
        });
        process.exit(EXIT_OK);
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('demo')
    .description('run the implemented pipeline stages over a fixture change')
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      try {
        await withApp(globals, async ({ reviews, renderer }) => {
          const result = await reviews.runDemo();
          emit(result, renderer, globals);
        });
        process.exit(EXIT_OK);
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('config')
    .description('print the resolved configuration')
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      try {
        await withApp(globals, ({ config }) => {
          const resolved = {
            nodeEnv: config.nodeEnv,
            llmProvider: config.providerName,
            llmModel: config.model ?? '(provider default)',
            contextTokenBudget: config.contextTokenBudget,
            blastRadiusMaxHops: config.blastRadiusMaxHops,
          };
          process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
          return Promise.resolve();
        });
        process.exit(EXIT_OK);
      } catch (error) {
        fail(error);
      }
    });

  return program;
}

if (require.main === module) {
  buildProgram().parseAsync(process.argv).catch(fail);
}
