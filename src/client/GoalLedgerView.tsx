/**
 * The v3 half of the card: what the ledger recorded about this session's goal.
 *
 * Pure presentation. Every string comes from the view-model in `./ledger.ts`;
 * this file only lays it out. There are no buttons: the goal belongs to the
 * host's native goal tool, and the owner acts there, not here.
 *
 * @module dsh-autopilot/client/GoalLedgerView
 */

import type { CSSProperties, ReactNode } from 'react'
import type { LedgerProjection, LegacyRunProjection } from '../domain/ledger-types.js'
import {
  autoContinueView, delegationRows, goalView, hostRestartLine, legacyRunLines, legacySummaryRows,
  LEGACY_NOTE, linkRows, reviewRows,
} from './ledger.js'
import type { DelegationRow, ReviewRow } from './ledger.js'
import { badge, muted, toneColor } from './styles.js'

export interface GoalLedgerViewProps {
  /** The session's ledger, or undefined when none has been served yet. */
  readonly ledger?: LedgerProjection | undefined
  /** Archived v1 run details already fetched (one request per run). */
  readonly legacyRuns?: readonly LegacyRunProjection[] | undefined
  /** The archived v1 session-log rendering, shown inside the archived section. */
  readonly legacyFold?: ReactNode
}

const headRow: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6,
}
const sectionHead: CSSProperties = { fontWeight: 600, marginTop: 10 }
const rowBox: CSSProperties = { marginTop: 4 }

function DelegationItem({ row }: { readonly row: DelegationRow }): JSX.Element {
  return (
    <div
      style={{ ...rowBox, paddingLeft: row.indent * 16 }}
      data-autopilot-delegation={row.childId}
      data-autopilot-route-match={row.match}
      data-autopilot-state={row.state}
    >
      <div>
        <span>{row.role}</span>
        <span style={muted} title={row.childId}> {row.shortId}</span>
        {row.title !== '' ? <span> {row.title}</span> : null}
        <span style={muted}> · gen {row.generation}</span>
        {row.replaces !== undefined ? <span style={muted}> · replaces {row.replaces}</span> : null}
        {' '}
        <span style={badge(toneColor(row.stateTone))}>{row.state}</span>
        {row.stateNote !== undefined ? <span style={muted}> {row.stateNote}</span> : null}
      </div>
      <div style={muted}>
        selected {row.selected} · observed {row.observed}
      </div>
      <div style={muted}>{row.source}</div>
      <div>
        <span style={badge(toneColor(row.matchTone))}>{row.matchText}</span>
      </div>
      {row.diagnostic !== undefined ? <div style={muted}>{row.diagnostic}</div> : null}
      {row.escalation !== undefined ? <div style={badge(toneColor('warn'))}>{row.escalation}</div> : null}
    </div>
  )
}

function ReviewItem({ row }: { readonly row: ReviewRow }): JSX.Element {
  return (
    <div
      style={rowBox}
      data-autopilot-review-independence={row.reduced ? 'reduced' : 'cross-family'}
    >
      <div>
        <span style={badge(toneColor(row.verdictTone))}>{row.verdict}</span>
        {' '}
        <span>{row.subject}</span>
        <span style={muted}> · {row.findings}</span>
      </div>
      <div style={muted}>reviewer {row.reviewer}</div>
      <div>
        {row.reduced
          ? <span style={badge(toneColor('warn'))}>reduced independence</span>
          : null}
        {row.reduced ? ' ' : ''}
        <span style={row.reduced ? undefined : muted}>{row.independence}</span>
      </div>
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
function LegacySection({ ledger, legacyRuns, legacyFold }: GoalLedgerViewProps): JSX.Element | null {
  const summaries = ledger === undefined ? [] : legacySummaryRows(ledger.legacyRuns)
  if (summaries.length === 0 && legacyFold === undefined && (legacyRuns ?? []).length === 0) return null
  return (
    <div data-autopilot-legacy="" style={{ marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 6 }}>
      <div style={sectionHead}>Autopilot run <span style={muted}>(archived, read-only)</span></div>
      <div style={muted}>{LEGACY_NOTE}</div>
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
  const { ledger } = props
  if (ledger === undefined) {
    return (
      <div data-autopilot-ledger="">
        <div style={headRow}><span style={{ fontWeight: 600 }}>Goal autopilot</span></div>
        <div style={muted}>no goal ledger recorded for this session</div>
        <LegacySection {...props} />
      </div>
    )
  }
  const goal = goalView(ledger)
  const auto = autoContinueView(ledger)
  const restart = hostRestartLine(ledger)
  const delegations = delegationRows(ledger)
  const reviews = reviewRows(ledger)
  const links = linkRows(ledger)
  return (
    <div data-autopilot-ledger="">
      <div style={headRow}>
        <span style={{ fontWeight: 600 }}>Goal autopilot</span>
        <span style={badge(toneColor(goal.tone))} data-autopilot-goal-phase={goal.phase}>{goal.label}</span>
      </div>
      {goal.objective !== undefined ? <div style={{ marginBottom: 4 }}>{goal.objective}</div> : null}
      {goal.next !== undefined ? <div>{goal.next}</div> : null}
      {goal.seen !== undefined ? <div style={muted}>{goal.seen}</div> : null}

      <div style={{ marginTop: 6 }}>
        <span style={{ color: toneColor(auto.tone) }}>{auto.text}</span>
      </div>
      {auto.restartNote !== undefined ? <div>{auto.restartNote}</div> : null}
      {restart !== undefined ? <div style={muted}>{restart}</div> : null}
      {ledger.depth.source !== 'plugin-default'
        ? (
          <div style={muted}>
            executor-lead depth {ledger.depth.executorLead} ({ledger.depth.source})
            {ledger.depth.note !== undefined ? ` · ${ledger.depth.note}` : ''}
          </div>
          )
        : null}
      {ledger.notes.map((n, i) => <div key={`${i}:${n}`} style={muted}>{n}</div>)}

      {ledger.previousGoals.length > 0
        ? (
          <div style={{ ...muted, marginTop: 6 }} data-autopilot-previous-goals="">
            <div>previous goals</div>
            {ledger.previousGoals.map(g => (
              <div key={g.goalId}>
                {g.goalId}{g.status !== undefined ? ` · ${g.status}` : ''}
                {g.objective !== undefined ? ` · ${g.objective}` : ''}
              </div>
            ))}
          </div>
          )
        : null}

      {delegations.length > 0
        ? (
          <div data-autopilot-delegations="">
            <div style={sectionHead}>Delegations</div>
            {delegations.map(r => <DelegationItem key={r.childId} row={r} />)}
          </div>
          )
        : null}

      {reviews.length > 0
        ? (
          <div data-autopilot-reviews="">
            <div style={sectionHead}>Reviews</div>
            {reviews.map(r => <ReviewItem key={r.key} row={r} />)}
          </div>
          )
        : null}

      {links.length > 0
        ? (
          <div data-autopilot-links="">
            <div style={sectionHead}>Links</div>
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

      <LegacySection {...props} />
    </div>
  )
}
