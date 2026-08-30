import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepoService, NotAGitRepositoryError, UnknownRefError } from './git-repo.service';

/**
 * Runs against a real repository built by real git commands.
 *
 * Rename detection, `--` vs `...` range semantics, hunk headers with an omitted count, and
 * what `git show` does for a path that does not exist at a ref are all guarantees belonging
 * to git, not to this code. A mocked simple-git would only assert that the service agrees
 * with my assumptions about git — which is the thing most likely to be wrong.
 */
describe('GitRepoService (real repository)', () => {
  const service = new GitRepoService();
  let repo: string;

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  }

  function write(path: string, content: string): void {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ripplereview-git-'));
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');

    write('src/pricing.ts', 'export function total(items: number[]): number {\n  return 1;\n}\n');
    write('src/untouched.ts', 'export const untouched = true;\n');
    write('src/doomed.ts', 'export const doomed = true;\n');
    write('src/old-name.ts', 'export const renamedThing = 42;\n');
    git('add', '.');
    git('commit', '-m', 'base');

    // A modification, an addition, a deletion and a rename, in one commit.
    write(
      'src/pricing.ts',
      'export function total(items: number[], discount = 0): number {\n  return 1 - discount;\n}\n',
    );
    write('src/checkout.ts', "import { total } from './pricing';\nexport const c = total([]);\n");
    rmSync(join(repo, 'src/doomed.ts'));
    git('mv', 'src/old-name.ts', 'src/new-name.ts');
    git('add', '-A');
    git('commit', '-m', 'head');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('recognises a git repository', async () => {
    await expect(service.assertRepository(repo)).resolves.toBeUndefined();
  });

  it('rejects a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ripplereview-plain-'));
    try {
      await expect(service.assertRepository(plain)).rejects.toBeInstanceOf(NotAGitRepositoryError);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('resolves a ref to a full sha', async () => {
    const sha = await service.resolveRef(repo, 'HEAD');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects an unknown ref instead of silently diffing against nothing', async () => {
    await expect(service.resolveRef(repo, 'no-such-branch')).rejects.toBeInstanceOf(
      UnknownRefError,
    );
  });

  it('reports a modified file with its hunks', async () => {
    const change = await service.changeSet(repo, 'HEAD~1', 'HEAD');
    const pricing = change.files.find((f) => f.path === 'src/pricing.ts');

    expect(pricing).toBeDefined();
    expect(pricing?.status).toBe('modified');
    expect(pricing?.hunks.length).toBeGreaterThan(0);
  });

  it('reports an added file', async () => {
    const change = await service.changeSet(repo, 'HEAD~1', 'HEAD');
    const added = change.files.find((f) => f.path === 'src/checkout.ts');
    expect(added?.status).toBe('added');
  });

  it('reports a deleted file', async () => {
    const change = await service.changeSet(repo, 'HEAD~1', 'HEAD');
    const deleted = change.files.find((f) => f.path === 'src/doomed.ts');
    expect(deleted?.status).toBe('deleted');
  });

  it('detects a rename rather than reporting a delete plus an add', async () => {
    const change = await service.changeSet(repo, 'HEAD~1', 'HEAD');
    const renamed = change.files.find((f) => f.path === 'src/new-name.ts');

    expect(renamed?.status).toBe('renamed');
    expect(renamed?.previousPath).toBe('src/old-name.ts');
    expect(change.files.some((f) => f.path === 'src/old-name.ts')).toBe(false);
  });

  it('leaves an unchanged file out of the change set', async () => {
    const change = await service.changeSet(repo, 'HEAD~1', 'HEAD');
    expect(change.files.some((f) => f.path === 'src/untouched.ts')).toBe(false);
  });

  it('keeps the raw diff, which the reviewer always sees in full', async () => {
    const change = await service.changeSet(repo, 'HEAD~1', 'HEAD');
    expect(change.rawDiff).toContain('diff --git');
    expect(change.rawDiff).toContain('discount');
  });

  it('reads a file at a ref', async () => {
    const content = await service.fileAtRef(repo, 'HEAD~1', 'src/pricing.ts');
    expect(content).toContain('items: number[]): number');
    expect(content).not.toContain('discount');
  });

  it('answers null for a path that does not exist at that ref', async () => {
    // checkout.ts was added on HEAD; at the base it simply is not there.
    await expect(service.fileAtRef(repo, 'HEAD~1', 'src/checkout.ts')).resolves.toBeNull();
  });

  it('answers null rather than throwing for a nonexistent ref', async () => {
    await expect(service.fileAtRef(repo, 'nope', 'src/pricing.ts')).resolves.toBeNull();
  });
});
