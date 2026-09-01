import { CorpusCase } from '../types';
import { WHOLE_CHANGE_TOLERANCE } from '../matcher';
import { buildRepo } from './build-repo';

/**
 * The defect corpus.
 *
 * Five cases, chosen so the result can be wrong in both directions. Three carry defects a
 * diff-only reviewer is structurally blind to. One carries a defect visible in the diff
 * alone — the control, where graph context should make no difference; if it helps there
 * too, the effect is "more context" rather than "better context". One carries no defect at
 * all, where the correct answer is silence and the only thing measurable is whether the
 * extra context provokes invented problems.
 *
 * Every repository compiles at both commits. A defect that also breaks the build would be
 * caught by tsc and would never reach a reviewer.
 */

// ---------------------------------------------------------------------------------------
// 1. Signature drift: a new parameter with a default, and a caller that never passes it.
// ---------------------------------------------------------------------------------------

const signatureDrift: CorpusCase = {
  name: 'signature-drift',
  summary:
    'PriceService.total gains a `discount` parameter with a default of 0. The checkout ' +
    'path is updated to pass it; the invoicing path, two modules away, is not — so every ' +
    'invoice silently prices at full rate. Compiles cleanly either way.',
  defects: [
    {
      id: 'invoice-ignores-discount',
      kind: 'cross-module',
      file: 'src/invoicing/invoice.builder.ts',
      line: 9,
      lineTolerance: 6,
      acceptCategories: ['cross-module-regression', 'correctness'],
      description:
        'buildInvoice still calls total() with one argument, so the discount defaults to 0 ' +
        'and invoices disagree with what the customer was charged.',
    },
  ],
  build: () =>
    buildRepo({
      base: {
        'src/pricing/price.service.ts': `export interface LineItem {
  price: number;
  quantity: number;
}

export class PriceService {
  total(items: LineItem[]): number {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}
`,
        'src/checkout/checkout.service.ts': `import { LineItem, PriceService } from '../pricing/price.service';

export class CheckoutService {
  private readonly pricing = new PriceService();

  charge(items: LineItem[]): number {
    return this.pricing.total(items);
  }
}
`,
        'src/invoicing/invoice.builder.ts': `import { LineItem, PriceService } from '../pricing/price.service';

export class InvoiceBuilder {
  private readonly pricing = new PriceService();

  buildInvoice(items: LineItem[], reference: string): string {
    const amount = this.pricing.total(items);
    return reference + ': ' + amount.toFixed(2);
  }
}
`,
      },
      head: {
        'src/pricing/price.service.ts': `export interface LineItem {
  price: number;
  quantity: number;
}

export class PriceService {
  total(items: LineItem[], discount = 0): number {
    const gross = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return gross - discount;
  }
}
`,
        'src/checkout/checkout.service.ts': `import { LineItem, PriceService } from '../pricing/price.service';

export class CheckoutService {
  private readonly pricing = new PriceService();

  charge(items: LineItem[], discount: number): number {
    return this.pricing.total(items, discount);
  }
}
`,
      },
    }),
};

// ---------------------------------------------------------------------------------------
// 2. A new import that closes a dependency cycle.
// ---------------------------------------------------------------------------------------

const newCycle: CorpusCase = {
  name: 'new-cycle',
  summary:
    'SessionStore imports AuditLog to record evictions. AuditLog already imports ' +
    'SessionStore to look up who was logged in, so the change closes a cycle between the ' +
    'two modules. Nothing in the diff hints that the other direction exists.',
  defects: [
    {
      id: 'session-audit-cycle',
      kind: 'cycle',
      file: 'src/session/session.store.ts',
      line: 1,
      lineTolerance: WHOLE_CHANGE_TOLERANCE,
      acceptCategories: ['circular-dependency', 'architecture'],
      description:
        'session.store.ts -> audit.log.ts -> session.store.ts. The change creates the ' +
        'cycle; the diff shows only the new import.',
    },
  ],
  build: () =>
    buildRepo({
      base: {
        'src/session/session.store.ts': `export interface Session {
  id: string;
  userId: string;
}

const sessions = new Map<string, Session>();

export function findSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function evict(id: string): void {
  sessions.delete(id);
}
`,
        'src/audit/audit.log.ts': `import { findSession } from '../session/session.store';

const entries: string[] = [];

export function record(event: string, sessionId: string): void {
  const session = findSession(sessionId);
  entries.push(event + ' by ' + (session ? session.userId : 'unknown'));
}

export function history(): string[] {
  return entries;
}
`,
      },
      head: {
        'src/session/session.store.ts': `import { record } from '../audit/audit.log';

export interface Session {
  id: string;
  userId: string;
}

const sessions = new Map<string, Session>();

export function findSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function evict(id: string): void {
  record('session.evicted', id);
  sessions.delete(id);
}
`,
      },
    }),
};

// ---------------------------------------------------------------------------------------
// 3. A layering violation, against a rule the repository declares.
// ---------------------------------------------------------------------------------------

const layeringBreach: CorpusCase = {
  name: 'layering-breach',
  summary:
    'The Order domain entity gains a `reload()` that queries the database directly, ' +
    'crossing the boundary declared in .ripplereview.rules. The import is one line and ' +
    'looks entirely ordinary in the diff.',
  defects: [
    {
      id: 'domain-imports-infrastructure',
      kind: 'architecture',
      file: 'src/domain/order.ts',
      line: 1,
      lineTolerance: WHOLE_CHANGE_TOLERANCE,
      acceptCategories: ['architecture'],
      description:
        'src/domain/order.ts imports src/infrastructure/database.ts, forbidden by the ' +
        'repository rule "deny src/domain/** -> src/infrastructure/**".',
    },
  ],
  build: () =>
    buildRepo({
      base: {
        '.ripplereview.rules': `# The domain layer must not reach into infrastructure.
deny src/domain/** -> src/infrastructure/**
`,
        'src/domain/order.ts': `export class Order {
  constructor(
    readonly id: string,
    readonly total: number,
  ) {}

  isLarge(): boolean {
    return this.total > 1000;
  }
}
`,
        'src/infrastructure/database.ts': `export function query(sql: string): Record<string, string>[] {
  return [{ sql }];
}
`,
        'src/application/order.service.ts': `import { Order } from '../domain/order';

export class OrderService {
  summarise(order: Order): string {
    return order.id + (order.isLarge() ? ' (large)' : '');
  }
}
`,
      },
      head: {
        'src/domain/order.ts': `import { query } from '../infrastructure/database';

export class Order {
  constructor(
    readonly id: string,
    readonly total: number,
  ) {}

  isLarge(): boolean {
    return this.total > 1000;
  }

  reload(): Record<string, string>[] {
    return query('select * from orders where id = ' + this.id);
  }
}
`,
      },
    }),
};

// ---------------------------------------------------------------------------------------
// 4. Control: a defect entirely inside one function, visible in the diff alone.
// ---------------------------------------------------------------------------------------

const localBug: CorpusCase = {
  name: 'local-bug',
  summary:
    'A pagination helper is rewritten and the new boundary check is off by one, so the ' +
    'last page is dropped. Everything needed to see it is in the diff. THE CONTROL: graph ' +
    'context should not help here, and if it does the effect is "more context" rather ' +
    'than "better context".',
  defects: [
    {
      id: 'off-by-one-last-page',
      kind: 'local',
      file: 'src/paging/paginate.ts',
      line: 8,
      lineTolerance: 6,
      acceptCategories: ['correctness'],
      description:
        'The loop condition uses `<` against pageCount after pageCount was changed to a ' +
        'count rather than a last index, so the final page is never emitted.',
    },
  ],
  build: () =>
    buildRepo({
      base: {
        'src/paging/paginate.ts': `export function pageStarts(totalItems: number, pageSize: number): number[] {
  const lastIndex = Math.floor((totalItems - 1) / pageSize);
  const starts: number[] = [];
  for (let page = 0; page <= lastIndex; page++) {
    starts.push(page * pageSize);
  }
  return starts;
}
`,
        'src/reports/listing.ts': `import { pageStarts } from '../paging/paginate';

export function listingPages(total: number): number {
  return pageStarts(total, 25).length;
}
`,
      },
      head: {
        'src/paging/paginate.ts': `export function pageStarts(totalItems: number, pageSize: number): number[] {
  const pageCount = Math.ceil(totalItems / pageSize);
  const starts: number[] = [];
  for (let page = 0; page < pageCount - 1; page++) {
    starts.push(page * pageSize);
  }
  return starts;
}
`,
      },
    }),
};

// ---------------------------------------------------------------------------------------
// 5. Control: a correct change with nothing wrong with it.
// ---------------------------------------------------------------------------------------

const cleanRefactor: CorpusCase = {
  name: 'clean-refactor',
  summary:
    'A pure rename plus an extracted helper, behaviour identical, no caller affected. ' +
    'THE OTHER CONTROL: the correct answer is no findings, so this measures whether the ' +
    'extra context provokes invented problems.',
  defects: [],
  build: () =>
    buildRepo({
      base: {
        'src/format/currency.ts': `export function fmt(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  return '$' + rounded.toFixed(2);
}
`,
        'src/ui/receipt.ts': `import { fmt } from '../format/currency';

export function receiptLine(label: string, amount: number): string {
  return label + ' ' + fmt(amount);
}
`,
      },
      head: {
        'src/format/currency.ts': `function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function fmt(value: number): string {
  return '$' + roundToCents(value).toFixed(2);
}
`,
      },
    }),
};

export const CORPUS: CorpusCase[] = [
  signatureDrift,
  newCycle,
  layeringBreach,
  localBug,
  cleanRefactor,
];

export function caseByName(name: string): CorpusCase | undefined {
  return CORPUS.find((entry) => entry.name === name);
}
