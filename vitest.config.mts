import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'eval/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/__fixtures__/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/interfaces/**', 'src/**/__fixtures__/**'],
    },
  },
  // Nest resolves constructor dependencies from `emitDecoratorMetadata`, which esbuild
  // (Vitest's default transform) does not emit. SWC does, so DI works under test.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
