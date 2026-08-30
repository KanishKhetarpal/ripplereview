import { Module } from '@nestjs/common';
import { GitRepoService } from './git-repo.service';

@Module({
  providers: [GitRepoService],
  exports: [GitRepoService],
})
export class IngestModule {}
