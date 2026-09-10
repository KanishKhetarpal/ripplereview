export interface DecoratorInfo {
  /** Decorator name, e.g. "Injectable", "Controller", "Inject". */
  name: string;
  /** Raw source text of each call argument, for decorators used as factories. */
  arguments: string[];
}

export interface ConstructorParamInfo {
  name: string;
  /** Source text of the parameter's type annotation, if present. */
  typeName?: string;
  decorators: DecoratorInfo[];
}

export interface ClassDeclarationInfo {
  name: string;
  isExported: boolean;
  isDefaultExport: boolean;
  decorators: DecoratorInfo[];
  constructorParams: ConstructorParamInfo[];
  methodNames: string[];
}
