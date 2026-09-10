# Provenance

This directory is a vendored, unmodified snapshot of eleven files from `arch-lens`
(`https://github.com/KanishKhetarpal/arch-lens` locally at `~/projects/arch-lens`), the
sibling project this repository already reuses code from with attribution (see `PLAN.md`
§2 — the cycle detector, graph metrics and module resolver already living in `src/graph/`
were vendored from the same place). It is not a public third-party OSS repository; it is
real, organically-grown, MIT-licensed production code from a different project by the same
author, used here because the eval corpus needed real complexity to mutate rather than
another hand-typed toy snippet. Scaling the corpus to a genuine third-party OSS repository
remains open — see `README.md`'s known limitations.

- **Pinned commit:** `eaf8753818e33e239915a866e6e1d5c647d31611`
- **License:** MIT — see `LICENSE` in this directory (copied verbatim from arch-lens).

## Files

The transitive closure of relative imports starting from the two files the mutation touches
(`graph/builder/module-specifier-resolver.ts`, `graph/builder/dependency-graph-builder.ts`
and `dataflow/builder/di-graph-builder.ts`, its untouched second caller):

```
src/graph/builder/module-specifier-resolver.ts
src/graph/builder/dependency-graph-builder.ts
src/graph/interfaces/graph.interface.ts
src/dataflow/builder/di-graph-builder.ts
src/dataflow/interfaces/di-graph.interface.ts
src/dataflow/analysis/layer-classifier.ts
src/parser/interfaces/module-symbol.interface.ts
src/parser/interfaces/class-declaration.interface.ts
src/parser/interfaces/import-declaration.interface.ts
src/parser/interfaces/export-declaration.interface.ts
src/parser/interfaces/function-declaration.interface.ts
```

Every file above is byte-for-byte what arch-lens has at that commit. Nothing here was
trimmed or reformatted — a subset that compiles cleanly on its own was chosen instead, so
"vendored" means what it says.

## `src/_harness-shims.d.ts` is NOT vendored content

The eval harness builds each corpus case in a bare temp directory and never runs
`pnpm install`, so a real npm import has nothing to resolve against. The two vendored
builder files import `@nestjs/common` (for `@Injectable()`) and `node:path` (`posix.*`) —
real dependencies of arch-lens, which is a NestJS app throughout. `_harness-shims.d.ts` is
a small ambient module declaration, written for this fixture, that satisfies exactly those
two imports at the type level so the vendored files compile standalone. It changes nothing
about how the vendored code reads or behaves; it exists for the same reason `buildRepo`
already synthesizes a `tsconfig.json` for every corpus case.
