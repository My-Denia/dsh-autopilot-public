import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: {
      // apply() may publish the bundled skill through the filesystem fallback.
      // Pin the scan root so the suite never writes the developer's real
      // skills directory.
      DSH_AGENTS_HOME: join(process.cwd(), '.test-tmp', 'agents-home'),
    },
  },
})
