/**
 * Display language for the card: which of two languages to speak, the strings
 * in each, and how to print a time.
 *
 * DOM-FREE, like `./ledger.ts`: vitest drives this module and `tsconfig.test.json`
 * has no DOM lib, so `document` and `navigator` are reached through a loose
 * structural cast and every read is guarded.
 *
 * Where the language comes from. The host (dsh desktop) exposes a `locale`
 * cordis service: `getLocale().active` is `'zh' | 'en'` and `subscribe` fires
 * when the owner switches. `index.ts` hands that service to {@link bindHostLocale}.
 * Until it is bound (or on a host without it) the fallbacks are, in order,
 * `document.documentElement.lang` (the host locale plugin also sets it) and
 * `navigator.language`; the last resort is English.
 *
 * Only presentation is localized. Values the ledger recorded (reasons, notes,
 * titles, model names, goal ids) are shown verbatim in whichever language.
 *
 * @module dsh-autopilot/client/i18n
 */

export type Lang = 'zh' | 'en'

/** `zh*` is Chinese, any other non-empty tag is English, an empty/missing tag is no answer. */
export function langFromTag(tag: string | undefined): Lang | undefined {
  if (tag === undefined) return undefined
  const t = tag.trim().toLowerCase()
  if (t === '') return undefined
  return t.startsWith('zh') ? 'zh' : 'en'
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** The part of the host `locale` service this module reads. */
export interface HostLocaleLike {
  getLocale(): { readonly active: string }
  subscribe(fn: () => void): () => void
}

interface LooseGlobals {
  readonly document?: { readonly documentElement?: { readonly lang?: string } }
  readonly navigator?: { readonly language?: string }
}

function loose(): LooseGlobals {
  return globalThis as unknown as LooseGlobals
}

let bound: HostLocaleLike | undefined
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of [...listeners]) {
    try { fn() } catch { /* one bad subscriber never stops the others */ }
  }
}

/**
 * Use the host's locale service as the source of truth. Returns the release
 * that unbinds it; releasing a binding that was already replaced does nothing.
 * `undefined` (a host without the service) binds nothing.
 */
export function bindHostLocale(locale: HostLocaleLike | undefined): () => void {
  if (locale === undefined) return () => {}
  bound = locale
  let unsubscribe: () => void = () => {}
  try { unsubscribe = locale.subscribe(emit) } catch { /* a locale that cannot notify still answers reads */ }
  emit()
  return () => {
    try { unsubscribe() } catch { /* already gone */ }
    if (bound === locale) {
      bound = undefined
      emit()
    }
  }
}

/** The language to show now. */
export function currentLang(): Lang {
  if (bound !== undefined) {
    try {
      const fromHost = langFromTag(bound.getLocale().active)
      if (fromHost !== undefined) return fromHost
    } catch { /* fall through to the document */ }
  }
  const g = loose()
  return langFromTag(g.document?.documentElement?.lang)
    ?? langFromTag(g.navigator?.language)
    ?? 'en'
}

/** Subscribe to language changes; returns the unsubscribe. */
export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A recorded ISO instant as local, human-readable time (`2026/11/04 16:29:37`
 * in Chinese, `Nov 4, 2026, 16:29:37` in English). Unparseable input comes back
 * verbatim. `timeZone` is for tests and previews; by default the viewer's own.
 */
export function formatTime(iso: string, lang: Lang, timeZone?: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  try {
    return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', {
      year: 'numeric',
      month: lang === 'zh' ? '2-digit' : 'short',
      day: lang === 'zh' ? '2-digit' : 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(ms))
  } catch {
    return iso
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Strings
// ─────────────────────────────────────────────────────────────────────────────

export interface Strings {
  readonly title: string
  readonly noLedger: string
  readonly details: string
  readonly delegations: string
  readonly reviews: string
  readonly links: string
  readonly legacyHeading: string
  readonly legacyHeadingNote: string
  readonly legacyNote: string

  // goal
  readonly noGoalLabel: string
  readonly statusNotRead: string
  readonly status: Readonly<Record<'active' | 'paused' | 'blocked' | 'complete', string>>
  readonly noGoalNext: string
  readonly nextActive: string
  readonly nextPaused: string
  readonly nextBlocked: string
  readonly nextComplete: string
  readonly goalId: string
  readonly revision: string
  readonly firstSeen: string
  readonly lastRead: string
  readonly autoContinue: string
  readonly autoAvailable: string
  readonly autoUnavailable: string
  readonly autoWarn: (reason: string) => string
  /** The auto-continue reason in plain words for its code (verbatim when there is no code or it is unknown). */
  readonly autoReason: (code: string | undefined, reason: string) => string
  /** Same, with the verbatim recorded reason kept in parentheses (details). */
  readonly autoReasonDetail: (code: string | undefined, reason: string) => string
  /** A reasoning-effort value as the body shows it. */
  readonly effortValue: (value: string) => string
  /** Same, with the raw value kept in parentheses (details). */
  readonly effortValueDetail: (value: string) => string
  readonly restartNote: string
  readonly hostRestart: (at: string, lost: number) => string
  readonly depth: string
  readonly previousGoals: string
  readonly notes: string
  readonly retired: (keys: string) => string
  readonly keySeparator: string
  readonly colon: string

  // delegations
  readonly roles: Readonly<Record<string, string>>
  readonly states: Readonly<Record<string, string>>
  readonly lostNote: string
  readonly escalated: (reason: string) => string
  readonly modelUsed: string
  readonly notObserved: string
  readonly mismatchWarn: (selected: string, used: string) => string
  readonly cannotRead: string
  readonly roleId: string
  readonly childId: string
  readonly generation: string
  readonly replaces: string
  readonly task: string
  readonly selectedRoute: string
  readonly observedRoute: string
  readonly modelSource: string
  readonly effortSource: string
  readonly matchResult: string
  readonly match: Readonly<Record<'match' | 'mismatch' | 'pending' | 'unreadable', string>>
  readonly sources: Readonly<Record<string, string>>
  readonly sourceLine: (model: string, effort: string) => string
  readonly generationShort: (n: number) => string
  readonly replacesShort: (id: string) => string
  readonly selectedNothing: string
  readonly observedNothing: string
  readonly noEffortSent: string
  readonly noEffortObserved: string
  readonly effort: string

  // reviews
  readonly verdicts: Readonly<Record<'pass' | 'needs-fix' | 'blocked', string>>
  readonly severities: Readonly<Record<'blocker' | 'major' | 'minor', string>>
  readonly findingCount: (n: number, severity: string) => string
  readonly noFindings: string
  readonly listSeparator: string
  readonly crossFamily: string
  readonly reducedKnown: string
  readonly reducedUnknown: string
  readonly reducedPrefix: string
  readonly reviewer: string
  readonly reviewerId: string
  readonly reviewedAt: string
  readonly independenceNote: string
  readonly excludedFamilies: string
  readonly noneRecorded: string
  readonly subject: string

  // links
  readonly linkKind: Readonly<Record<'issue' | 'pr', string>>
}

const en: Strings = {
  title: 'Goal autopilot',
  noLedger: 'no goal ledger recorded for this session',
  details: 'Details',
  delegations: 'Delegations',
  reviews: 'Reviews',
  links: 'Links',
  legacyHeading: 'Autopilot run',
  legacyHeadingNote: '(archived, read-only)',
  legacyNote: 'Archived run from an earlier plugin version, shown read-only. Its gates and closeout are history; nothing here needs action.',

  noGoalLabel: 'no goal recorded',
  statusNotRead: 'status not read',
  status: { active: 'active', paused: 'paused', blocked: 'blocked', complete: 'complete' },
  noGoalNext: 'no dsh-goal has been seen in this session',
  nextActive: 'Rounds continue automatically while the session is idle.',
  nextPaused: 'Paused. Only you can resume it (say "continue").',
  nextBlocked: 'Blocked. The block reason is not recorded in the ledger; check the goal before resuming (a round-limit block needs a higher round cap first).',
  nextComplete: 'Goal complete. You can start a new goal in this session.',
  goalId: 'Goal id',
  revision: 'Revision',
  firstSeen: 'First seen',
  lastRead: 'Last read',
  autoContinue: 'Auto-continue',
  autoAvailable: 'available',
  autoUnavailable: 'unavailable',
  autoWarn: reason => `Will not auto-continue: ${reason}`,
  autoReason: (_code, reason) => reason,
  autoReasonDetail: (_code, reason) => reason,
  effortValue: v => v,
  effortValueDetail: v => v,
  restartNote: 'After a host restart the goal does not continue on its own: say "continue" once to resume it. A scheduled reminder does not re-arm the goal.',
  hostRestart: (at, n) => `host restart at ${at}: ${n} running ${n === 1 ? 'child was' : 'children were'} lost (not restarted automatically)`,
  depth: 'Executor-lead depth',
  previousGoals: 'Previous goals',
  notes: 'Notes',
  retired: keys => `Your config has retired settings: ${keys}. You can delete them; they have no effect.`,
  keySeparator: ', ',
  colon: ': ',

  roles: {
    scout: 'Scout', clerk: 'Clerk', worker: 'Worker', 'executor-lead': 'Executor lead', planner: 'Planner', reviewer: 'Reviewer',
  },
  states: {
    starting: 'starting', running: 'running', idle: 'idle', completed: 'completed', failed: 'failed', cancelled: 'cancelled', lost: 'lost',
  },
  lostNote: 'lost after host restart, not restarted automatically',
  escalated: reason => `asked to escalate: ${reason}`,
  modelUsed: 'Model used',
  notObserved: 'not observed yet',
  mismatchWarn: (selected, used) => `Model mismatch: selected ${selected}, used ${used}`,
  cannotRead: 'could not read the child session',
  roleId: 'Role id',
  childId: 'Child id',
  generation: 'Generation',
  replaces: 'Replaces',
  task: 'Task',
  selectedRoute: 'Selected route',
  observedRoute: 'Observed route',
  modelSource: 'Model source',
  effortSource: 'Effort source',
  matchResult: 'Route check',
  match: {
    match: 'observed matches selected',
    mismatch: 'MISMATCH: observed differs from selected',
    pending: 'not observed yet (child has not sent a request)',
    unreadable: 'could not read the child session',
  },
  sources: {
    arg: 'call argument', pin: 'role pin', ladder: 'routing ladder', inherit: 'host default',
    'catalog-default': 'model catalog default', 'host-default': 'host default',
  },
  sourceLine: (model, effort) => `model from ${model} · effort from ${effort}`,
  generationShort: n => `gen ${n}`,
  replacesShort: id => `replaces ${id}`,
  selectedNothing: 'nothing sent (host default)',
  observedNothing: 'not observed yet',
  noEffortSent: 'no effort sent',
  noEffortObserved: 'no effort observed',
  effort: 'effort',

  verdicts: { pass: 'Review passed', 'needs-fix': 'Needs fixes', blocked: 'Review blocked' },
  severities: { blocker: 'blocker', major: 'major', minor: 'minor' },
  findingCount: (n, sev) => `${n} ${sev}`,
  noFindings: 'no findings',
  listSeparator: ', ',
  crossFamily: 'Independent review (different provider)',
  reducedKnown: 'no model from another provider was available',
  reducedUnknown: 'Reduced independence (see details for the reason)',
  reducedPrefix: 'Reduced independence: ',
  reviewer: 'Reviewer',
  reviewerId: 'Reviewer id',
  reviewedAt: 'Reviewed at',
  independenceNote: 'Independence note',
  excludedFamilies: 'Excluded providers',
  noneRecorded: 'none recorded',
  subject: 'Subject',

  linkKind: { issue: 'issue', pr: 'PR' },
}

const AUTO_CODE_ZH: Readonly<Record<string, string>> = {
  'driver-present': '会自动继续',
  'no-driver-in-composition': '当前宿主没有目标轮次驱动',
  'released-after-restart': '宿主重启后已释放',
  'not-yet-observed': '还没检测到目标轮次驱动',
  unknown: '无法检查宿主是否支持自动继续',
}

const EFFORT_ZH: Readonly<Record<string, string>> = {
  minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
}

const zh: Strings = {
  title: '目标自动推进',
  noLedger: '这个会话还没有目标记录',
  details: '详情',
  delegations: '委派',
  reviews: '审阅',
  links: '链接',
  legacyHeading: '自动推进运行',
  legacyHeadingNote: '（已归档，只读）',
  legacyNote: '早期插件版本留下的归档运行，仅供查看。其中的关口和收尾都是历史记录，无需处理。',

  noGoalLabel: '没有目标',
  statusNotRead: '未读到状态',
  status: { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成' },
  noGoalNext: '这个会话里还没有看到目标',
  nextActive: '会话空闲时会自动继续下一轮。',
  nextPaused: '已暂停，只有你能恢复（说“继续”）。',
  nextBlocked: '已受阻。记录里没有受阻原因，恢复前请先检查目标（因轮数上限受阻的，要先调高轮数上限）。',
  nextComplete: '目标已完成，可以在本会话里开始新目标。',
  goalId: '目标 ID',
  revision: '修订号',
  firstSeen: '首次看到',
  lastRead: '最近读取',
  autoContinue: '自动继续',
  autoAvailable: '可用',
  autoUnavailable: '不可用',
  autoWarn: reason => `不会自动继续：${reason}`,
  autoReason: (code, reason) => (code === undefined ? undefined : AUTO_CODE_ZH[code]) ?? reason,
  autoReasonDetail: (code, reason) => {
    const plain = code === undefined ? undefined : AUTO_CODE_ZH[code]
    return plain === undefined ? reason : `${plain}（${reason}）`
  },
  effortValue: v => EFFORT_ZH[v] ?? v,
  effortValueDetail: v => (EFFORT_ZH[v] === undefined ? v : `${EFFORT_ZH[v]}（${v}）`),
  restartNote: '宿主重启后目标不会自己继续：说一次“继续”即可恢复。定时提醒不会重新启动目标。',
  hostRestart: (at, n) => `宿主在 ${at} 重启：${n} 个运行中的子任务丢失（不会自动重启）`,
  depth: '执行负责人层级深度',
  previousGoals: '以往目标',
  notes: '备注',
  retired: keys => `配置里有已废弃的设置：${keys}，可以删除，不影响运行。`,
  keySeparator: '、',
  colon: '：',

  roles: {
    scout: '调研', clerk: '事务', worker: '执行', 'executor-lead': '执行负责人', planner: '规划', reviewer: '审阅',
  },
  states: {
    starting: '启动中', running: '运行中', idle: '空闲', completed: '已完成', failed: '失败', cancelled: '已取消', lost: '已丢失',
  },
  lostNote: '宿主重启后丢失，不会自动重启',
  escalated: reason => `请求升级：${reason}`,
  modelUsed: '实际模型',
  notObserved: '尚未观测到',
  mismatchWarn: (selected, used) => `实际模型与选定的不一致：选定 ${selected}，实际 ${used}`,
  cannotRead: '读不到子会话',
  roleId: '角色 ID',
  childId: '子任务 ID',
  generation: '代数',
  replaces: '接替',
  task: '任务',
  selectedRoute: '选定的模型',
  observedRoute: '观测到的模型',
  modelSource: '模型来源',
  effortSource: '推理强度来源',
  matchResult: '核对结果',
  match: {
    match: '观测到的与选定的一致',
    mismatch: '不一致：观测到的与选定的不同',
    pending: '尚未观测到（子任务还没发出请求）',
    unreadable: '读不到子会话',
  },
  sources: {
    arg: '调用参数', pin: '角色固定', ladder: '路由阶梯', inherit: '宿主默认',
    'catalog-default': '模型目录默认', 'host-default': '宿主默认',
  },
  sourceLine: (model, effort) => `模型取自${model} · 推理强度取自${effort}`,
  generationShort: n => `第 ${n} 代`,
  replacesShort: id => `接替 ${id}`,
  selectedNothing: '未发送（用宿主默认）',
  observedNothing: '尚未观测到',
  noEffortSent: '未指定推理强度',
  noEffortObserved: '未观测到推理强度',
  effort: '推理强度',

  verdicts: { pass: '审阅通过', 'needs-fix': '需要修改', blocked: '审阅未通过（阻断）' },
  severities: { blocker: '阻断', major: '主要', minor: '次要' },
  findingCount: (n, sev) => `${sev} ${n}`,
  noFindings: '没有意见',
  listSeparator: ' · ',
  crossFamily: '跨厂商独立审阅',
  reducedKnown: '没有其他厂商的模型可选',
  reducedUnknown: '独立性降低（原因见详情）',
  reducedPrefix: '独立性降低：',
  reviewer: '审阅者',
  reviewerId: '审阅者 ID',
  reviewedAt: '审阅时间',
  independenceNote: '独立性说明',
  excludedFamilies: '排除的厂商',
  noneRecorded: '未记录',
  subject: '审阅对象',

  linkKind: { issue: 'Issue', pr: 'PR' },
}

export const STRINGS: Record<Lang, Strings> = { en, zh }
