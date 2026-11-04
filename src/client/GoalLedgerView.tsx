/**
 * The v3 half of the card: what the ledger recorded about this session's goal.
 *
 * Pure presentation. Every string comes from the view-model in `./ledger.ts`
 * and the table in `./i18n.ts`; this file only lays it out. Plain words in the
 * body, technical lines inside native `<details>` (no state, no buttons: the
 * goal belongs to the host's native goal tool, and the owner acts there).
 *
 * @module dsh-autopilot/client/GoalLedgerView
 */

import { useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { LedgerProjection, LegacyRunProjection } from '../domain/ledger-types.js'
import { currentLang, STRINGS, subscribeLang } from './i18n.js'
import type { Lang } from './i18n.js'
import {
  autoContinueView, delegationRows, goalView, hostRestartLine, legacyRunLines, legacySummaryRows,
  linkRows, retiredNotice, reviewRows,
} from './ledger.js'
import type { DelegationRow, DetailRow, ReviewRow } from './ledger.js'
import { badge, muted, toneColor } from './styles.js'

/** The display language: the override if given, else the host's, following changes. */
export function useLang(override?: Lang): Lang {
  const host = useSyncExternalStore(subscribeLang, currentLang, currentLang)
  return override ?? host
}

export interface GoalLedgerViewProps {
  /** The session's ledger, or undefined when none has been served yet. */
  readonly ledger?: LedgerProjection | undefined
  /** Archived v1 run details already fetched (one request per run). */
  readonly legacyRuns?: readonly LegacyRunProjection[] | undefined
  /** The archived v1 session-log rendering, shown inside the archived section. */
  readonly legacyFold?: ReactNode
  /** Force a language (tests, previews). Default: the host's. */
  readonly lang?: Lang | undefined
  /** Force a time zone for printed times (tests, previews). Default: the viewer's. */
  readonly timeZone?: string | undefined
}

const headRow: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6,
}
const sectionHead: CSSProperties = { fontWeight: 600, marginTop: 10 }
const rowBox: CSSProperties = { marginTop: 4 }

/** A collapsed, muted label/value list; nothing when there is nothing to list. */
function Details({ rows, label }: { readonly rows: readonly DetailRow[]; readonly label: string }): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <details style={{ ...muted, fontSize: 11 }} data-autopilot-details="">
      <summary style={{ cursor: 'pointer' }}>{label}</summary>
      {rows.map((r, i) => (
        <div key={`${r.label}:${i}`} style={{ paddingLeft: 12 }}>
          {r.label === '' ? null : <span>{r.label} </span>}
          <span style={{ color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' }}>{r.value}</span>
        </div>
      ))}
    </details>
  )
}

function DelegationItem({ row, lang }: { readonly row: DelegationRow; readonly lang: Lang }): JSX.Element {
  return (
    <div
      style={{ ...rowBox, paddingLeft: row.indent * 16 }}
      data-autopilot-delegation={row.childId}
      data-autopilot-route-match={row.match}
      data-autopilot-state={row.state}
    >
      <div>
        <span>{row.roleText}</span>
        <span style={muted} title={row.childId}> {row.role}</span>
        {row.title !== '' ? <span title={row.title}> {row.taskText}</span> : null}
        {' '}
        <span style={badge(toneColor(row.stateTone))}>{row.stateText}</span>
        {row.stateNote !== undefined ? <span style={muted}> {row.stateNote}</span> : null}
      </div>
      <div style={muted}>
        {STRINGS[lang].modelUsed}{STRINGS[lang].colon}{row.modelUsed}
        {row.ok ? <span title={row.matchText}> ✓</span> : null}
        {row.quietNote !== undefined ? <span> · {row.quietNote}</span> : null}
      </div>
      {row.warning !== undefined ? <div style={{ color: toneColor('error') }}>{row.warning}</div> : null}
      {row.diagnostic !== undefined ? <div style={muted}>{row.diagnostic}</div> : null}
      {row.escalation !== undefined ? <div style={badge(toneColor('warn'))}>{row.escalation}</div> : null}
      <Details rows={row.details} label={STRINGS[lang].details} />
    </div>
  )
}

function ReviewItem({ row, lang }: { readonly row: ReviewRow; readonly lang: Lang }): JSX.Element {
  return (
    <div
      style={rowBox}
      data-autopilot-review-independence={row.reduced ? 'reduced' : 'cross-family'}
    >
      <div>
        <span style={badge(toneColor(row.verdictTone))}>{row.verdictText}</span>
        {' '}
        <span>{row.subject}</span>
        <span style={muted}> · {row.findings}</span>
      </div>
      <div style={row.reduced ? { color: toneColor('warn') } : muted}>{row.independenceText}</div>
      <Details rows={row.details} label={STRINGS[lang].details} />
    </div>
  )
}

/** One archived run's detail lines (final phase, gates, history, sandbox restore). */
function LegacyDetail({ run }: { readonly run: LegacyRunProjection }): JSX.Element {
  return (
    <div style={{ ...muted, paddingLeft: 12 }} data-autopilot-legacy-detail={run.runId}>
      {legacyRunLines(run).map((line, i) => (
        <div key={`${line.label}:${i}`}>
          <span>{line.label === '' ? ' ' : `${line.label} `}</span>
          <span style={{ color: 'var(--dsw-alias-label-primary)' }}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}

/** The archived-run section: summaries, fetched details, and any v1 fold content. */
function LegacySection({ ledger, legacyRuns, legacyFold, lang }: GoalLedgerViewProps & { readonly lang: Lang }): JSX.Element | null {
  const S = STRINGS[lang]
  const summaries = ledger === undefined ? [] : legacySummaryRows(ledger.legacyRuns)
  if (summaries.length === 0 && legacyFold === undefined && (legacyRuns ?? []).length === 0) return null
  return (
    <div data-autopilot-legacy="" style={{ marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 6 }}>
      <div style={sectionHead}>{S.legacyHeading} <span style={muted}>{S.legacyHeadingNote}</span></div>
      <div style={muted}>{S.legacyNote}</div>
      {summaries.map(s => (
        <div key={s.runId} style={rowBox} data-autopilot-legacy-run={s.runId}>
          <div>
            {s.rejected ? <span style={badge(toneColor('error'))}>unreadable</span> : null}
            {s.rejected ? ' ' : ''}
            <span style={s.rejected ? undefined : muted}>{s.text}</span>
          </div>
          <div style={muted}>{s.sandbox}</div>
          {(legacyRuns ?? []).filter(r => r.runId === s.runId).map(run => <LegacyDetail key={run.runId} run={run} />)}
        </div>
      ))}
      {(legacyRuns ?? []).filter(r => !summaries.some(s => s.runId === r.runId)).map(run => (
        <div key={run.runId} style={rowBox} data-autopilot-legacy-run={run.runId}>
          <div style={muted}>run {run.runId.length > 8 ? `${run.runId.slice(0, 8)}…` : run.runId} · {run.objective}</div>
          <LegacyDetail run={run} />
        </div>
      ))}
      {legacyFold !== undefined ? <div style={{ marginTop: 6 }}>{legacyFold}</div> : null}
    </div>
  )
}

/**
 * Render the ledger projection (or its absence) and the archived runs.
 *
 * @param props.ledger - the session ledger, when one is available.
 * @param props.legacyRuns - fetched details of archived runs.
 * @param props.legacyFold - optional archived v1 content for the legacy section.
 */
export function GoalLedgerView(props: GoalLedgerViewProps): JSX.Element {
  const { ledger, timeZone } = props
  const lang = useLang(props.lang)
  const S = STRINGS[lang]
  if (ledger === undefined) {
    return (
      <div data-autopilot-ledger="">
        <div style={headRow}><span style={{ fontWeight: 600 }}>{S.title}</span></div>
        <div style={muted}>{S.noLedger}</div>
        <LegacySection {...props} lang={lang} />
      </div>
    )
  }
  const goal = goalView(ledger, lang, timeZone)
  const auto = autoContinueView(ledger, lang)
  const restart = hostRestartLine(ledger, lang, timeZone)
  const delegations = delegationRows(ledger, lang)
  const reviews = reviewRows(ledger, lang, timeZone)
  const links = linkRows(ledger, lang)
  const retired = retiredNotice(ledger, lang)
  return (
    <div data-autopilot-ledger="">
      <div style={headRow}>
        <span style={{ fontWeight: 600 }}>{S.title}</span>
        <span style={badge(toneColor(goal.tone))} data-autopilot-goal-phase={goal.phase}>{goal.statusText}</span>
      </div>
      {goal.objective !== undefined ? <div style={{ marginBottom: 4 }}>{goal.objective}</div> : null}
      {goal.nextText !== undefined ? <div>{goal.nextText}</div> : null}
      {auto.warning !== undefined ? <div style={{ color: toneColor(auto.tone) }}>{auto.warning}</div> : null}
      {auto.restartNote !== undefined ? <div>{auto.restartNote}</div> : null}
      {restart !== undefined ? <div style={muted}>{restart}</div> : null}
      <Details rows={goal.details} label={S.details} />

      {delegations.length > 0
        ? (
          <div data-autopilot-delegations="">
            <div style={sectionHead}>{S.delegations}</div>
            {delegations.map(r => <DelegationItem key={r.childId} row={r} lang={lang} />)}
          </div>
          )
        : null}

      {reviews.length > 0
        ? (
          <div data-autopilot-reviews="">
            <div style={sectionHead}>{S.reviews}</div>
            {reviews.map(r => <ReviewItem key={r.key} row={r} lang={lang} />)}
          </div>
          )
        : null}

      {links.length > 0
        ? (
          <div data-autopilot-links="">
            <div style={sectionHead}>{S.links}</div>
            {links.map(l => (
              <div key={l.key} data-autopilot-link="">
                {l.href !== undefined
                  ? <a href={l.href} target="_blank" rel="noreferrer">{l.label}</a>
                  : <span>{l.label}</span>}
              </div>
            ))}
          </div>
          )
        : null}

      {retired !== undefined ? <div style={{ ...muted, fontSize: 11, marginTop: 8 }} data-autopilot-retired="">{retired}</div> : null}

      <LegacySection {...props} lang={lang} />
    </div>
  )
}
