import { defineConfig } from 'vitest/config';

// Run the catalog SQL against an isolated in-memory PostgreSQL instance.
// The default suite uses Cloudflare's worker pool, which cannot load PGlite's
// local data file from Windows paths.
export default defineConfig({
  test: { include: ['test/games-list-duplicates.spec.ts'] },
});
