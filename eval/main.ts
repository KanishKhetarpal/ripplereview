#!/usr/bin/env node
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { toMarkdown, toSvg, verdict } from './report';
import { EvalRunner } from './runner';

const OUT_DIR = join(process.cwd(), 'eval', 'out');

async function main(): Promise<void> {
  const program = new Command()
    .name('ripplereview-eval')
    .description('Score graph-grounded review against a diff-only baseline on a defect corpus.')
    .option('-n, --runs <n>', 'runs per arm per case', (v) => Number(v), 3)
    .option('--only <cases>', 'comma-separated case names', '')
    .option('--out <dir>', 'where to write the scorecard', OUT_DIR)
    .parse(process.argv);

  const options = program.opts<{ runs: number; only: string; out: string }>();

  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error('--runs must be a whole number of at least 1');
  }

  const report = await new EvalRunner().run({
    runs: options.runs,
    only: options.only ? options.only.split(',').map((s) => s.trim()) : [],
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });

  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'scorecard.md'), toMarkdown(report), 'utf8');
  writeFileSync(join(options.out, 'scorecard.json'), JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(join(options.out, 'catch-rate.svg'), toSvg(report), 'utf8');

  process.stdout.write(`\n${verdict(report)}\n`);
  process.stdout.write(`\nwrote ${join(options.out, 'scorecard.md')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
