/**
 * The plugin's declared configuration.
 *
 * One key, no routing: a dispatch route comes from the call itself or from the
 * host default; the plugin pins no model, keeps no catalog, and has no ladder,
 * onboarding, coverage or work-class vocabulary. A 0.3.0 configuration is not
 * silently reinterpreted because none of its keys exist here: schemastery
 * ignores unknown keys, so a profile that still carries them mounts with the
 * default behaviour. The 0.4.0 clean break is documented in CHANGELOG.md.
 */

import Schema from '@deepseek-ai/schemastery'

/** Whether the bundled adapter skill is published on mount. */
export type SkillInstallMode = 'auto' | 'off'

/** Raw config accepted from the profile patch layer. */
export interface ConfigInput {
  readonly skillInstall?: SkillInstallMode
}

export const Config: ReturnType<typeof Schema.object> = Schema.object({
  skillInstall: Schema.union([
    Schema.const('auto').description('Publish the bundled skill: through the host skill registry when it exists, otherwise as a file copy under $DSH_AGENTS_HOME/skills.'),
    Schema.const('off').description('Publish nothing.'),
  ]).default('auto').description('Whether the bundled adapter skill is published on mount.'),
}).description('dsh-goal-autopilot: role-scoped delegation, one independent review, and an in-memory delegation ledger.')

/** The resolved config every module reads. */
export interface ResolvedConfig {
  readonly skillInstall: SkillInstallMode
}

/** Resolve raw config, tolerating a plain object as tests and older loaders pass. */
export function resolveConfig(input?: ConfigInput | undefined): ResolvedConfig {
  return { skillInstall: input?.skillInstall === 'off' ? 'off' : 'auto' }
}
