import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: [],
  },
  resolve: {
    alias: {
      obsidian: new URL('./obsidian.mock.mjs', import.meta.url).pathname,
    },
  },
});
