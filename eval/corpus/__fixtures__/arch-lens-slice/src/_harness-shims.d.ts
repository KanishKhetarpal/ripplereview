// Compile-time-only shims for this fixture's real npm/Node imports. The eval harness never
// runs `pnpm install` for a corpus repo, so these ambient declarations exist purely to let
// the vendored files below type-check standalone. See SOURCE.md.

declare module '@nestjs/common' {
  export function Injectable(): ClassDecorator;
}

declare module 'node:path' {
  export const posix: {
    dirname(path: string): string;
    normalize(path: string): string;
    join(...paths: string[]): string;
    basename(path: string): string;
  };
}
