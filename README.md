# RippleReview

Graph-grounded AI code review.

A diff-only reviewer — including every generic LLM review bot — can only see the lines that
changed. It is structurally blind to what those lines *reach*: the caller three modules away
that silently keeps compiling, the import that just closed a dependency cycle, the edge that
crossed a layer boundary.

RippleReview computes that blast radius deterministically from the repository's dependency
graph and hands the model **cited evidence** alongside the diff. Same model, better input.

> **Status: Phase 0.** The scaffold, the LLM adapter, response validation, the grounding
> guard and both output surfaces are built and tested. The ingest, graph engine and context
> assembler are not. `ripplereview review` refuses and names the missing phase rather than
> returning an empty result — see [PLAN.md](PLAN.md) for the phased roadmap, and
> `GET /api/v1/health` for the live stage report.

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

Run the pipeline stages that exist, over a fixture change:

```bash
node dist/cli/main-cli.js demo
```

```
RippleReview
main..feature/discounts  /demo/shop
graph-grounded  |  echo/echo-stub  |  2ms

Blast radius
  1 changed symbol(s) across 1 file(s)
  2 impacted site(s) within 3 hop(s)
  1 circular dependency introduced

Findings (1)
  ...
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

  review <repo>   review the change between two refs
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
| `POST /api/v1/review` | `501` until the graph engine and assembler land |
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
only, and its ts-morph loader deliberately skips dependency resolution. Symbol-level blast
radius needs a type-checked project and a reference graph that does not exist there — that
is net-new work in Phase 1, and it is the half that makes this project different.

---

## Licence

MIT
