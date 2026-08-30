import { Module } from '@nestjs/common';
import { IngestModule } from '../ingest/ingest.module';
import { BlastRadiusService } from './blast-radius.service';
import { ChangeImpactService } from './change-impact.service';
import { ChangedSymbolResolverService } from './changed-symbol-resolver.service';
import { CycleDetector } from './cycle-detector';
import { GraphMetricsService } from './graph-metrics';
import { ModuleGraphBuilderService } from './module-graph-builder.service';
import { ProjectLoaderService } from './project-loader.service';

@Module({
  imports: [IngestModule],
  providers: [
    ProjectLoaderService,
    ModuleGraphBuilderService,
    CycleDetector,
    GraphMetricsService,
    ChangedSymbolResolverService,
    BlastRadiusService,
    ChangeImpactService,
  ],
  exports: [ChangeImpactService],
})
export class GraphModule {}
