import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Project, SourceFile as TsSourceFile } from 'ts-morph';
import { SourceFile } from '../ingest/interfaces/source-file.interface';

export type LoadMode = 'tsconfig' | 'glob';

export interface LoadedProject {
  project: Project;
  /** Files under the repo root, excluding declaration files. The graph's node set. */
  files: SourceFile[];
  mode: LoadMode;
  loadMs: number;
}

const GLOB_PATTERNS = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.jsx'];

const IGNORED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
];

@Injectable()
export class ProjectLoaderService {
  private readonly logger = new Logger(ProjectLoaderService.name);

  /**
   * Loads a repository once, for everything: the module graph, changed-symbol resolution
   * and the symbol reference lookups behind the blast radius.
   *
   * `skipFileDependencyResolution: true` is the measured choice, not the cautious one. It
   * stops ts-morph pulling in every transitively imported file outside the project — mostly
   * node_modules type definitions. Probed on three repositories, the reference sets it
   * produces are IDENTICAL to a fully resolving load, for functions, classes and methods
   * alike, because the tsconfig has already added every file in the repository and
   * references between them resolve from the file set rather than from the resolver.
   *
   * What it changes is cost, and by a lot. On a 677-file repository: 741ms and 160MB to
   * load, against 25s and 2.2GB resolving. The saving is what makes a repository of that
   * size reviewable at all — the resolving load OOM'd Node's default heap outright.
   *
   * The limitation it does impose: a reference living in a file the tsconfig does not
   * include (a sibling package in a monorepo) is not found. That under-reports the blast
   * radius, which is the acceptable direction to be wrong in — and is reported, not hidden.
   */
  load(repoPath: string): LoadedProject {
    const startedAt = Date.now();
    const tsConfigFilePath = join(repoPath, 'tsconfig.json');
    const hasTsConfig = existsSync(tsConfigFilePath);

    const project = hasTsConfig
      ? new Project({ tsConfigFilePath, skipFileDependencyResolution: true })
      : new Project({
          compilerOptions: { allowJs: true, target: 99 },
          skipFileDependencyResolution: true,
        });

    if (!hasTsConfig) {
      project.addSourceFilesAtPaths([
        ...GLOB_PATTERNS.map((pattern) => join(repoPath, pattern).split(sep).join('/')),
        ...IGNORED_DIRS.map((dir) => `!${join(repoPath, dir, '**').split(sep).join('/')}`),
      ]);
    }

    const files = this.graphFiles(project, repoPath);
    const loadMs = Date.now() - startedAt;

    this.logger.debug(
      `loaded ${repoPath} via ${hasTsConfig ? 'tsconfig' : 'glob'}: ` +
        `${files.length} graph file(s) of ${project.getSourceFiles().length} parsed, ${loadMs}ms`,
    );

    return { project, files, mode: hasTsConfig ? 'tsconfig' : 'glob', loadMs };
  }

  /**
   * The files that become graph nodes.
   *
   * Declaration files are excluded: they carry imports but no implementation, so counting
   * them inflates fan-in for types that are merely *described* somewhere. They stay in the
   * ts-morph project, because the language service needs them to resolve references.
   *
   * Files outside the repository root are excluded too — a tsconfig may reference a sibling
   * package, and those have no meaningful repo-relative path to serve as a node id.
   */
  private graphFiles(project: Project, repoPath: string): SourceFile[] {
    const files: SourceFile[] = [];

    for (const file of project.getSourceFiles()) {
      const absolutePath = file.getFilePath();
      if (this.isDeclarationFile(file)) continue;
      if (absolutePath.includes('/node_modules/')) continue;

      const relativePath = relative(repoPath, absolutePath).split(sep).join('/');
      if (relativePath.startsWith('..') || relativePath === '') continue;

      files.push({ absolutePath, relativePath });
    }

    return files;
  }

  private isDeclarationFile(file: TsSourceFile): boolean {
    return file.getFilePath().endsWith('.d.ts');
  }
}
