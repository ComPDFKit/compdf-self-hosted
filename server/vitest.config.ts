import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Vitest config for the server app. esbuild (vite's default TS transform)
// does not emit decorator metadata, which the DI container relies on at runtime
// (Test.createTestingModule reads design:paramtypes). unplugin-swc fills that
// gap for the test environment.
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['{src,test}/**/*.spec.ts'],
    clearMocks: true,
    resetMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['src/main.ts', 'src/**/*.module.ts'],
    },
  },
});
