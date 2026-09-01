import { Module } from '@nestjs/common';
import { ContextAssemblerService } from './context-assembler.service';
import { EvidenceBuilder } from './evidence-builder';
import { TOKEN_COUNTER, createTokenCounter } from './token-counter';
import { TypeExtractor } from './type-extractor';

@Module({
  providers: [
    EvidenceBuilder,
    TypeExtractor,
    { provide: TOKEN_COUNTER, useFactory: () => createTokenCounter() },
    ContextAssemblerService,
  ],
  exports: [ContextAssemblerService, EvidenceBuilder, TOKEN_COUNTER],
})
export class ContextModule {}
