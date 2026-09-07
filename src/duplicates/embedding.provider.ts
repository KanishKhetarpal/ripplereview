import { Injectable } from '@nestjs/common';
import { FINGERPRINT_DIMENSIONS, FINGERPRINT_VERSION, fingerprint } from './code-fingerprint';
import { FunctionUnit } from './function-unit';

/**
 * Turns function units into vectors.
 *
 * The seam an embedding model plugs into. Nothing downstream — the index, the pgvector
 * store, the detector, the evidence — knows where a vector came from; they all work on a
 * unit vector of a declared width.
 *
 * There is exactly ONE implementation today, and that is a deliberate stopping point
 * rather than an unfinished one. See `StructuralEmbedder` for why the default is
 * deterministic, and README "Duplicate logic" for what a model-backed one would buy.
 */
export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  /**
   * Bumped when the representation changes. Persisted vectors carry it, so an old vector
   * is never compared against a new one.
   */
  readonly version: number;
  embed(units: FunctionUnit[]): Promise<Float64Array[]>;
}

export const EMBEDDER = Symbol('EMBEDDER');

/**
 * The default: deterministic, offline, free.
 *
 * Chosen over an embedding API on three measured grounds.
 *
 * It works. Run over a 4,000-file production codebase it surfaced real copy-paste at the
 * top of the ranking — one helper duplicated across four services, another across two, and
 * a pair of event handlers that are the same function with a different name.
 *
 * It is reproducible, which a structural claim has to be. The project's first rule is that
 * the graph asserts structure and the model does not; sourcing "this duplicates that" from
 * a vendor's model would make the one class of claim the reviewer is not allowed to invent
 * depend on a model after all — and on a version of it that can change under us.
 *
 * It runs everywhere. No key, no network, no database. A reviewer on a laptop with no
 * configuration gets the same answer as CI.
 *
 * What it gives up: it matches STRUCTURE, so two functions that compute the same thing by
 * genuinely different means do not match. That is the case a neural embedding would add,
 * and it is the reason this interface exists.
 */
@Injectable()
export class StructuralEmbedder implements Embedder {
  readonly name = 'structural';
  readonly dimensions = FINGERPRINT_DIMENSIONS;
  readonly version = FINGERPRINT_VERSION;

  /**
   * Async to match the interface, not because this needs to be.
   *
   * A model-backed embedder batches over the network; forcing every caller to be written
   * for that now is what stops the seam being a lie later.
   */
  embed(units: FunctionUnit[]): Promise<Float64Array[]> {
    return Promise.resolve(units.map((unit) => fingerprint(unit.tokens)));
  }
}
