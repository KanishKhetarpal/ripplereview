import { ClassDeclarationInfo } from '../../parser/interfaces/class-declaration.interface';
import { ArchitecturalLayer } from '../interfaces/di-graph.interface';

/**
 * True for classes Nest's injector actually instantiates as controllers or
 * providers. `@Module(...)` classes are decorated too, but they're wiring
 * metadata, not something anything else takes a constructor dependency on.
 */
export function isDiParticipant(cls: ClassDeclarationInfo): boolean {
  return cls.decorators.some((decorator) => decorator.name !== 'Module');
}

/**
 * Classifies a DI-participating class into an architectural layer.
 * `Repository`-suffixed classes are checked before `@Injectable()` because
 * TypeORM/Prisma-style repositories are ordinary `@Injectable()` providers —
 * the decorator alone can't tell them apart from services.
 */
export function classifyLayer(cls: ClassDeclarationInfo): ArchitecturalLayer {
  const decoratorNames = new Set(cls.decorators.map((decorator) => decorator.name));

  if (decoratorNames.has('Controller')) {
    return 'controller';
  }
  if (/Repository$/.test(cls.name)) {
    return 'repository';
  }
  if (decoratorNames.has('Injectable')) {
    return 'service';
  }
  return 'other';
}
