import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: {
      // apply() copies the bundled skill into the scan root by default.
      // Pin the dest HOME so the suite never writes the owner's ~/.agents.
      DSH_AUTOPILOT_SKILL_HOME: join(process.cwd(), '.test-tmp', 'skill-home'),
    },
  },
})
