import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A small repository whose dependency structure is known exactly, so blast radius can be
 * asserted as a SET rather than as "more than zero".
 *
 * Shape at HEAD:
 *
 *   pricing/price.service.ts       PriceService.total          <- the change
 *      ^                     ^
 *      | (hop 1)             | (hop 1)
 *   checkout/checkout.service.ts   reporting/revenue.report.ts
 *      ^
 *      | (hop 2)
 *   api/order.controller.ts
 *
 *   util/format.ts                 imported by nobody in that chain — the control. If it
 *                                  ever shows up in the blast radius, the walk is wrong.
 *   domain/order.ts -> infra/db.ts a layering violation, introduced at HEAD
 *   pricing -> checkout            a cycle, introduced at HEAD
 */
export interface FixtureRepo {
  path: string;
  git: (...args: string[]) => string;
}

const BASE_FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        strict: true,
        skipLibCheck: true,
      },
      include: ['src/**/*'],
    },
    null,
    2,
  ),

  'src/pricing/price.service.ts': `export interface Item {
  price: number;
}

export class PriceService {
  total(items: Item[]): number {
    return items.reduce((sum, item) => sum + item.price, 0);
  }

  cheapest(items: Item[]): number {
    return Math.min(...items.map((item) => item.price));
  }
}
`,

  'src/checkout/checkout.service.ts': `import { Item, PriceService } from '../pricing/price.service';

export class CheckoutService {
  private readonly pricing = new PriceService();

  confirm(items: Item[]): string {
    const amount = this.pricing.total(items);
    return 'charged ' + amount;
  }
}
`,

  'src/reporting/revenue.report.ts': `import { Item, PriceService } from '../pricing/price.service';

export function buildRevenueRow(items: Item[]): string {
  const pricing = new PriceService();
  return 'revenue: ' + pricing.total(items);
}
`,

  'src/api/order.controller.ts': `import { CheckoutService } from '../checkout/checkout.service';

export class OrderController {
  private readonly checkout = new CheckoutService();

  create(): string {
    return this.checkout.confirm([{ price: 10 }]);
  }
}
`,

  // The control. Nothing in the pricing chain touches it.
  'src/util/format.ts': `export function formatMoney(value: number): string {
  return value.toFixed(2);
}
`,

  // A cycle that exists at BASE and still exists at HEAD. It must be reported as
  // pre-existing, not blamed on this change.
  'src/legacy/left.ts': `import { right } from './right';

export function left(): number {
  return right() + 1;
}
`,

  'src/legacy/right.ts': `import { left } from './left';

export function right(): number {
  return typeof left === 'function' ? 2 : 3;
}
`,

  'src/domain/order.ts': `export class Order {
  readonly id = 'order-1';
}
`,

  'src/infra/db.ts': `export function query(sql: string): string[] {
  return [sql];
}
`,

  '.ripplereview.rules': `# The domain layer must not reach into infrastructure.
deny src/domain/** -> src/infra/**
`,
};

/** What HEAD changes relative to base. */
const HEAD_FILES: Record<string, string> = {
  // The change under review: a new parameter on PriceService.total.
  'src/pricing/price.service.ts': `import type { CheckoutService } from '../checkout/checkout.service';

export interface Item {
  price: number;
}

export class PriceService {
  total(items: Item[], discount = 0): number {
    const gross = items.reduce((sum, item) => sum + item.price, 0);
    return gross - discount;
  }

  cheapest(items: Item[]): number {
    return Math.min(...items.map((item) => item.price));
  }

  describe(checkout?: CheckoutService): string {
    return checkout ? 'with checkout' : 'standalone';
  }
}
`,

  // Introduces the layering violation.
  'src/domain/order.ts': `import { query } from '../infra/db';

export class Order {
  readonly id = 'order-1';

  load(): string[] {
    return query('select 1');
  }
}
`,
};

export function buildFixtureRepo(): FixtureRepo {
  const path = mkdtempSync(join(tmpdir(), 'ripplereview-fixture-'));

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: path, encoding: 'utf8' });

  const write = (relative: string, content: string): void => {
    const absolute = join(path, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };

  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');

  for (const [relative, content] of Object.entries(BASE_FILES)) {
    write(relative, content);
  }
  git('add', '.');
  git('commit', '-m', 'base');

  for (const [relative, content] of Object.entries(HEAD_FILES)) {
    write(relative, content);
  }
  git('add', '-A');
  git('commit', '-m', 'head');

  return { path, git };
}
