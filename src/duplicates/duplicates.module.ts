import { Module } from '@nestjs/common';
import { DuplicateDetectorService } from './duplicate-detector.service';
import { DuplicateStoreService } from './duplicate-store.service';
import { EMBEDDER, StructuralEmbedder } from './embedding.provider';

/**
 * Duplicate-logic detection.
 *
 * The pool it needs comes from the global DbModule and resolves to null when no database
 * is configured, which is the ordinary case for a CLI run. Nothing here is conditional on
 * that: without a database the detector still finds duplicates inside the repository under
 * review, and only cross-repository matching is off.
 */
@Module({
  providers: [
    { provide: EMBEDDER, useClass: StructuralEmbedder },
    DuplicateStoreService,
    DuplicateDetectorService,
  ],
  exports: [DuplicateDetectorService, DuplicateStoreService, EMBEDDER],
})
export class DuplicatesModule {}
