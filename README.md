# RippleReview

Graph-grounded AI code review.

A diff-only reviewer — including every generic LLM review bot — can only see the lines that
changed. It is structurally blind to what those lines *reach*: the caller three modules away
that silently keeps compiling, the import that just closed a dependency cycle, the edge that
crossed a layer boundary.

RippleReview computes that blast radius deterministically from the repository's dependency
graph and hands the model **cited evidence** alongside the diff. Same model, better input.

> **Status: Phase 1.** The graph engine works: point `ripplereview impact` at a repository
> and it computes the real blast radius of a change, the cycles the change introduced, and
> any architecture rule it broke — all deterministically, with no model involved. The context
> assembler and the real LLM providers are Phase 2, so `ripplereview review` still refuses
> and names the missing phase rather than returning an empty result. See [PLAN.md](PLAN.md)
> for the roadmap and the measurements behind the design, and `GET /api/v1/health` for the
> live stage report.

---

## The thesis

We are not trying to out-reason the frontier model on a raw diff; everyone calls the same
model. The differentiator is context engineering, and it has to be measured rather than
asserted. Phase 3 exists to produce one number:

> same model + graph-grounded context vs. same model + diff-only context, on a corpus of
> known cross-module defects.

Two rules follow, and both are enforced in code:

**Structural claims come from the graph, not the model.** Blast radius, cycles and layering
violations are computed and cited. `enforceGrounding()` drops a structural finding that
cites nothing, and drops any finding citing an evidence id that was never supplied. An
invented call site presented with a citation is worse than no finding, because it reads as
verified.

**The eval harness is a deliverable.** The diff-only baseline runs the same provider, the
same model and the same prompt over the diff alone, so the comparison is fair.

---

## Quick start

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm build
```

Compute the blast radius of a change — the graph engine, no model, no API key:

```bash
node dist/cli/main-cli.js impact . --base HEAD~1 --head HEAD
```

```
RippleReview — change impact
HEAD~1..HEAD  /path/to/repo
134 modules, 313 edges  |  3 hop limit  |  1826ms

Changed symbols (36) and what they reach (15 sites)

  ConfigModule
    src/config/config.module.ts:7  class  modified
    1 hop  src/app.module.ts:7      AppModule
    2 hop  src/main.ts:6            bootstrap
    2 hop  src/cli/main-cli.ts:52   main
    3 hop  src/main.ts:10           <module>

Circular dependencies (1)
  INTRODUCED  src/checkout/checkout.service.ts <-> src/pricing/price.service.ts

Architecture violations (1)
  INTRODUCED  src/domain/order.ts -> src/infra/db.ts
    deny src/domain/** -> src/infra/**
```

That chain — a config change reaching `bootstrap` three modules away — is what a diff-only
reviewer cannot see.

Run the model half over a fixture change (offline, uses the `echo` stub):

```bash
node dist/cli/main-cli.js demo
```

Machine-readable output — stdout carries JSON and nothing else:

```bash
node dist/cli/main-cli.js --json demo
```

Start the REST API:

```bash
node dist/main.js
curl http://localhost:3000/api/v1/health
```

---

## CLI

```
ripplereview [--json] [--no-color] [-v] <command>

  impact <repo>   compute the blast radius of a change — graph engine only, no model
                  --base <ref>   default HEAD~1
                  --head <ref>   default HEAD, and must be the checked-out revision
                  --hops <n>     how far to walk (default BLAST_RADIUS_MAX_HOPS)
  review <repo>   review the change between two refs (Phase 2)
                  --base <ref>   default HEAD~1
                  --head <ref>   default HEAD
                  --diff-only    skip the graph engine (the eval baseline)
  demo            run the implemented stages over a fixture change
  config          print the resolved configuration
```

Exit codes are a contract with CI:

| Code | Meaning |
|---|---|
| 0 | the review ran and nothing blocking was found |
| 1 | the review ran and reported blocking findings *(severity gating lands in Phase 4)* |
| 2 | the review could not run |

---

## HTTP API

| Route | State |
|---|---|
| `GET /api/v1/health` | live report of which pipeline stages are implemented |
| `POST /api/v1/review/demo` | runs the implemented stages over the fixture change |
| `POST /api/v1/review` | `501` until the context assembler lands (Phase 2) |
| `GET /api/v1/review/runs/:id` | `501` until persistence lands (Phase 4) |

---

## Configuration

Copy `.env.example` to `.env`. Every variable is validated at startup and a bad value is a
clean error with exit code 2, never a stack trace half-way through a run.

| Variable | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `echo` | `echo` \| `openai` \| `gemini`. `echo` is the offline stub; it makes no network call. |
| `LLM_MODEL` | provider default | Recorded on every run. |
| `LLM_MAX_OUTPUT_TOKENS` | `4096` | |
| `LLM_TEMPERATURE` | `0` | |
| `OPENAI_API_KEY` / `GOOGLE_API_KEY` | — | Required when the matching provider is selected. |
| `CONTEXT_TOKEN_BUDGET` | `60000` | Ceiling for everything handed to the model (Phase 2). |
| `BLAST_RADIUS_MAX_HOPS` | `3` | Hops walked out from a changed symbol (Phase 1). |
| `PORT` | `3000` | |

Selecting `openai` or `gemini` today fails at boot with the phase it lands in. Falling back
to the stub would let a run report findings that no model ever produced.

---

## Architecture rules

Drop a `.ripplereview.rules` file in the repository you are reviewing (see
[`.ripplereview.rules.example`](.ripplereview.rules.example)):

```
# The domain layer must not reach into infrastructure.
deny src/domain/** -> src/infrastructure/**
```

An edge matching both sides is reported, and flagged separately when the change under review
is what created it. A malformed line is an error, not a skip — a rule silently ignored is a
rule its author believes is protecting them.

## Known limits

Honest about direction: the blast radius **under-reports** rather than inventing reach.

- A module-scope change (an edited import) has no declaration to look references up from, so
  its dependents are reported at module granularity only. The output says so.
- A reference in a file the repository's tsconfig does not include — a sibling package in a
  monorepo — is not found.
- Dependency injection by string token, and any computed `import()`, are invisible to a
  static graph.
- `--head` must be the checked-out revision. The graph is built from the files on disk, so
  another ref would resolve the diff's line numbers against different code; that is refused
  rather than silently wrong.
- A first reference lookup on a large repository (~700 files) costs ~18s and ~3GB of heap.

## Development

```bash
pnpm lint         # never auto-fixes; this is what CI runs
pnpm lint:fix
pnpm typecheck
pnpm test
pnpm build
```

The CLI end-to-end tests spawn the compiled binary, so they need `dist`. They skip locally
when it is absent and **fail hard under `CI=true`** — a skipped test on a build server means
the pipeline is vouching for behaviour nothing verified.

Vitest transforms with SWC rather than esbuild: esbuild does not emit
`emitDecoratorMetadata`, so Nest's constructor injection would silently fail to resolve
under the default transform.

---

## Built on Arch Lens

The parser, module dependency graph, Tarjan SCC cycle detection and fan-in/fan-out metrics
come from [arch-lens](https://github.com/KanishKhetarpal/arch-lens), an earlier
codebase-to-architecture-diagram generator by the same author.

What does **not** carry over is the interesting part: Arch Lens's graph is file-granularity
only — its edges are file-to-file imports, with no symbol layer at all. Symbol-level blast
radius is net-new, and it is the half that makes this project different.

One assumption from that reading turned out to be wrong, and measuring it is what caught it:
Arch Lens skips ts-morph's dependency resolution, and I expected symbol references to need
the opposite. They do not — the reference sets are identical either way, and the cheap loader
uses ~25x less memory. See [PLAN.md §2a](PLAN.md) for the numbers.

---

## Licence

MIT
