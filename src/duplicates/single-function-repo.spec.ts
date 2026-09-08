import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { ChangeSet } from '../ingest/interfaces/change-set.interface';
import { DuplicateDetectorService } from './duplicate-detector.service';
import { DuplicateStoreService, StoredMatch } from './duplicate-store.service';
import { StructuralEmbedder } from './embedding.provider';
import { FunctionUnit } from './function-unit';

/**
 * A repository holding exactly one substantial function.
 *
 * Its own right to exist: the detector used to return early on `units.length < 2`, which
 * was correct while the only search was in-memory — a lone function has nothing local to
 * compare against — and became wrong the moment there was a corpus of other repositories.
 * A single-function service could neither be told it had copied something nor contribute
 * anything for the next repository to be told about, and nothing said so.
 *
 * No database needed: what is under test is whether the store is CONSULTED, which a stub
 * answers better than a real one — a real store would also have to be made to contain a
 * matching row, and then a failure could mean either thing.
 */

const SOLE_FUNCTION = `export function prorateCharge(
  amount: number,
  daysUsed: number,
  daysInPeriod: number,
): number {
  if (daysInPeriod <= 0) {
    return 0;
  }

  const capped = Math.min(Math.max(daysUsed, 0), daysInPeriod);
  const ratio = capped / daysInPeriod;
  const raw = amount * ratio;
  const rounded = Math.round(raw * 100) / 100;

  return Math.max(rounded, 0);
}
`;

function singleFunctionProject(): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile('/repo/src/only.ts', SOLE_FUNCTION, { overwrite: true });
  return project;
}

/** The whole file is new, so every line in it is a changed line. */
function wholeFileAdded(path: string, lines: number): ChangeSet {
  return {
    baseRef: 'HEAD~1',
    headRef: 'HEAD',
    rawDiff: '',
    files: [
      {
        path,
        status: 'added',
        hunks: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines,
            changedNewLines: Array.from({ length: lines }, (_, i) => i + 1),
          },
        ],
      },
    ],
  };
}

interface StubStore {
  available: boolean;
  searched: number;
  remembered: { repo: string; units: FunctionUnit[] }[];
}

function stubStore(hits: StoredMatch[]): { store: DuplicateStoreService; state: StubStore } {
  const state: StubStore = { available: true, searched: 0, remembered: [] };

  const store = {
    get available(): boolean {
      return state.available;
    },
    search: (): Promise<StoredMatch[]> => {
      state.searched++;
      return Promise.resolve(hits);
    },
    remember: (repo: string, units: FunctionUnit[]): Promise<void> => {
      state.remembered.push({ repo, units });
      return Promise.resolve();
    },
  } as unknown as DuplicateStoreService;

  return { store, state };
}

describe('a repository with a single substantial function', () => {
  const embedder = new StructuralEmbedder();
  const changeSet = wholeFileAdded('src/only.ts', SOLE_FUNCTION.split('\n').length);

  it('is still compared against the corpus', async () => {
    const { store, state } = stubStore([
      {
        repo: 'test.example/library',
        file: 'src/shared/proration.ts',
        name: 'prorateCharge',
        line: 1,
        similarity: 1,
      },
    ]);

    const matches = await new DuplicateDetectorService(embedder, store).detect({
      project: singleFunctionProject(),
      repoRoot: '/repo',
      repoId: 'test.example/service',
      changeSet,
    });

    expect(state.searched).toBe(1);
    expect(matches).toHaveLength(1);
    expect(matches[0].scope).toBe('other-repository');
    expect(matches[0].duplicateOf.repo).toBe('test.example/library');
  });

  it('is still added to the corpus, so the NEXT repository can be told', async () => {
    const { store, state } = stubStore([]);

    await new DuplicateDetectorService(embedder, store).detect({
      project: singleFunctionProject(),
      repoRoot: '/repo',
      repoId: 'test.example/service',
      changeSet,
    });

    expect(state.remembered).toHaveLength(1);
    expect(state.remembered[0].repo).toBe('test.example/service');
    expect(state.remembered[0].units.map((unit) => unit.name)).toEqual(['prorateCharge']);
  });

  it('still does nothing when the change touched no function at all', async () => {
    // The guard that remains. Embedding every function in a repository on a review that
    // touched none of them is work with no possible output.
    const { store, state } = stubStore([]);

    const matches = await new DuplicateDetectorService(embedder, store).detect({
      project: singleFunctionProject(),
      repoRoot: '/repo',
      repoId: 'test.example/service',
      changeSet: wholeFileAdded('src/somewhere-else.ts', 3),
    });

    expect(matches).toEqual([]);
    expect(state.searched).toBe(0);
    expect(state.remembered).toEqual([]);
  });
});
