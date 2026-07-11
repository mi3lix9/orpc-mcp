import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
      exclude: ['**/*.test.ts', '**/*.test-d.ts'],
    },
  },
})
