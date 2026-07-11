import { defineConfig } from 'vitest/config'

// Model-layer tests only: pure logic, node environment, no DOM.
export default defineConfig({
  test: {
    include: ['src/renderer/src/**/*.test.ts'],
    environment: 'node',
  },
})
