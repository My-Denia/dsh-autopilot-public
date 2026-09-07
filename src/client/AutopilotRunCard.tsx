/**
 * The autopilot run card renderer.
 *
 * Presentation only: every value it shows was FOLDED FROM THE SESSION LOG by
 * `./definition.ts`, and the card's whole editorial stance is that it says so.
 * Each gate is labelled with the revision it was OBSERVED at, never derived;
 * a value the run never reported is rendered as an em-dash rather than a
 * default; and when the run's revision has moved past the newest phase
 * observation the header carries a "may have moved" badge instead of guessing.
 *
 * STYLING IS INLINE ON PURPOSE. `lib/client.js` is built by `tsc` plus
 * `scripts/wrap-client.mjs`, and neither resolves `import './x.css'` the way
 * tsdown does (see README §6, ceiling 3). Inline style objects over the
 * `--dsw-alias-*` variables are the supported alternative and are what
 * `dsh-context-doctor` does as well.
 *
 * @module dsh-autopilot/client/AutopilotRunCard
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  AutopilotAuditRow, AutopilotRunChatData, Observed,
} from './definition.js'
import { fetchLiveRun, overlayLive, pollDelayMs, pollKey, shouldPoll } from './live.js'
import type { LiveFetch, LiveRun } from './live.js'

/** The slot passes the whole chat node; the card reads only its data. */
export interface AutopilotRunCardProps {
  readonly node: { readonly data: AutopilotRunChatData }
  /**
   * The session this card is rendered in — the POLL KEY of last resort.
   *
   * NOT WIRED BY US, AND THAT IS THE POINT. `conversation.chat.node` is
   * declared `scope: 'session'` (`ui-conversation/src/client/apply.ts`), and
   * the scoped-slot renderer assembles every session-scoped entry's standard
   * kit with `standard['sessionId'] = info.sessionId`
   * (`ui-renderer/src/client/scoped-slots.tsx`), then renders the entry as
   * `<Comp {...kit} … {...ownerProps} />`. So this prop has been arriving all
   * along; the card simply never declared it. Declaring it is the whole
   * integration — no change to `index.ts`, no new inject, nothing to keep in
   * sync with the host.
   *
   * Optional because the type must also describe the card as vitest and the
   * bundle harness construct it, where no slot kit exists.
   */
  readonly sessionId?: string
  /**
   * Injected fetch, for tests and for a host that has none. Production leaves
   * it absent and the hook uses the browser's own `fetch` — same origin, so no
   * base URL and no credentials to configure.
   */
  readonly fetchJson?: LiveFetch
}

/**
 * Poll the host route while the run is not terminal.
 *
 * WHAT THIS HOOK IS AND IS NOT. It is a timer, two state slots and a mounted
 * flag. Every DECISION it appears to make — whether polling is warranted, how
 * long to wait, whether a response is usable, whether the answer changes what
 * the card shows — is delegated to a pure function in `./live.ts`, because
 * `react` is a host-provided external that this package cannot install, so a
 * test can never mount this component. Anything this function decides for
 * itself is, by construction, untestable here; so it decides as little as
 * possible.
 *
 * WHY `setTimeout` AND NOT `setInterval`: the delay is recomputed from the
 * card's own staleness after each answer, and an interval would pin the cadence
 * to whatever it was when the effect first ran. It also guarantees no overlap —
 * the next wait starts only after the previous answer has landed, so a slow
 * host cannot queue requests behind itself.
 *
 * THE UNMOUNT RULE: the flag is checked after every await, not just at the top.
 * A response that lands after the component is gone must not call `setState`,
 * and must not schedule the next timer either — that is how a "stopped" poll
 * keeps running forever in a tab the user has navigated away from.
 *
 * @param data - the folded card data, which supplies the gate and, when the
 * traffic reported one, the run id.
 * @param fetchJson - injected fetch; defaults to the browser's.
 * @param sessionId - the host-supplied session id, used as the poll key when
 * the fold never learned a run id (the common case: the engine's trimmed tool
 * results did not carry one before this round).
 * @returns the newest live answer, or undefined when none has landed.
 */
function useLiveRun(
  data: AutopilotRunChatData,
  fetchJson?: LiveFetch,
  sessionId?: string,
): LiveRun | undefined {
  const [live, setLive] = useState<LiveRun | undefined>(undefined)
  // The gate is read from a ref inside the timer so the effect does not restart
  // on every fold; the effect's identity depends only on the resolved poll key.
  const latest = useRef({ data, live, sessionId })
  latest.current = { data, live, sessionId }
  // The fold's runId when the traffic reported one, else this session's id.
  // See `pollKey`: a run's id IS its root session id, so the fallback is sound
  // rather than a guess, and a session with no run simply 404s in silence.
  const key = pollKey(data, sessionId)

  useEffect(() => {
    if (key === undefined) return
    // A host without `fetch` (server-side render, an exotic embedder) simply
    // never polls: the card keeps showing the session-log reconstruction, which
    // is exactly its behaviour before this existed.
    const request = fetchJson ?? (typeof fetch === 'function' ? ((url: string) => fetch(url)) : undefined)
    if (request === undefined) return

    let mounted = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      const answer = await fetchLiveRun(key, request)
      if (!mounted) return
      // A failed poll is not an event: leaving `live` untouched is what makes
      // the failure path "no worse than before polling existed".
      if (answer !== undefined) setLive(answer)
      schedule()
    }

    const schedule = (): void => {
      const now = latest.current
      if (!mounted || !shouldPoll(now.data, now.live, now.sessionId)) return
      timer = setTimeout(() => { void tick() }, pollDelayMs(now.data))
    }

    schedule()
    return () => {
      mounted = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [key, fetchJson])

  return live
}

const shell: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2)',
  padding: '10px 12px',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-primary)',
}

const headRow: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 6,
}

const title: CSSProperties = { fontWeight: 600 }
const muted: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)' }
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: '2px 12px',
}

const badge = (color: string): CSSProperties => ({
  border: `1px solid ${color}`,
  color,
  borderRadius: 4,
  padding: '0 5px',
  fontSize: 11,
})

/** Verdict/gate colouring; anything unrecognised stays neutral rather than guessing a mood. */
function toneOf(value: string | undefined): string {
  switch (value) {
    case 'pass':
      return 'var(--dsw-alias-state-success-primary)'
    case 'blocked':
    case 'needs-owner-decision':
      return 'var(--dsw-alias-state-error-primary)'
    case 'needs-fix':
    case 'needs-replan':
    case 'pending':
      return 'var(--dsw-alias-state-warn-primary)'
    default:
      return 'var(--dsw-alias-label-tertiary)'
  }
}

/** One observed value plus the revision it was observed at. */
/**
 * One line for the delegated executor.
 *
 * This is the CONSUMER `mergeExecutor` exists for. That fold keeps the earlier
 * `childId` alive across the partial `{generation, state}` records that
 * `StatusView` carries, and drops it the moment `generation` moves — measured
 * on `session-61a05524`, where the full record lands once and four later
 * status results carry only the partial one. Until this line existed the fold
 * had no reader, so its correctness could not be observed anywhere a human
 * looks (recorded as a defect by the 2026-08-25 browser verification).
 *
 * The childId is shown truncated: it is a UUID, it exists here to be RECOGNIZED
 * against the run's events, and a full one would wrap the card on a narrow
 * viewport.
 */
function executorLine(record: Readonly<Record<string, unknown>>): string {
  const parts: string[] = []
  if (typeof record.state === 'string') parts.push(record.state)
  if (typeof record.generation === 'number') parts.push(`gen ${record.generation}`)
  if (typeof record.executionRevision === 'number') parts.push(`exec r${record.executionRevision}`)
  const child = record.childId
  if (typeof child === 'string' && child.length > 0) {
    parts.push(`child ${child.length > 8 ? `${child.slice(0, 8)}…` : child}`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'reported with no fields'
}

function Field({ label, at }: { label: string; at: Observed<unknown> | undefined }): JSX.Element {
  if (at === undefined) {
    return (
      <div>
        <span style={muted}>{label} </span>
        <span style={muted} title="this run never reported the field">—</span>
      </div>
    )
  }
  const text = Array.isArray(at.value) ? at.value.join(', ') : String(at.value)
  return (
    <div>
      <span style={muted}>{label} </span>
      <span style={badge(toneOf(typeof at.value === 'string' ? at.value : undefined))}>{text}</span>
      <span
        style={muted}
        title={at.seq === undefined
          // No seq means the host route answered it. Saying "seq undefined"
          // would be worse than saying where it came from.
          ? `read live from the host route at run revision ${at.revision}`
          : `observed at run revision ${at.revision}, seq ${at.seq}`}
      > @r{at.revision}</span>
    </div>
  )
}

/** One audit dispatch row: role, verdict, and the auditor that produced it. */
function AuditRow({ row }: { row: AutopilotAuditRow }): JSX.Element {
  const verdict = row.failed ? 'errored' : row.settled ? (row.verdict ?? 'no verdict') : 'in flight'
  const route = row.route as { routeModel?: unknown; routeStatus?: unknown } | undefined
  return (
    <li style={{ marginBottom: 2 }}>
      <span style={badge(toneOf(row.settled && !row.failed ? row.verdict : undefined))}>{verdict}</span>
      <span> {row.kind}</span>
      <span style={muted}> · role {row.role ?? 'unstated'}</span>
      {typeof route?.routeModel === 'string'
        ? <span style={muted}> · {route.routeModel}{route.routeStatus === 'unverified' ? ' (unverified route)' : ''}</span>
        : null}
    </li>
  )
}

/**
 * Render one autopilot run card.
 *
 * @param props - the chat node carrying the folded run data.
 * @returns the card element.
 */
export function AutopilotRunCard({ node, sessionId, fetchJson }: AutopilotRunCardProps): JSX.Element {
  const live = useLiveRun(node.data, fetchJson, sessionId)
  // The overlay returns the SAME object when the live answer adds nothing, so a
  // poll that confirms what the card already knew costs no re-render below.
  const data = overlayLive(node.data, live)
  const isLive = data !== node.data
  const triage = data.triage
  return (
    <div style={shell} data-autopilot-run-card="">
      <div style={headRow}>
        <span style={title}>Autopilot run</span>
        <span style={badge(toneOf(data.phase?.value))}>{data.phase?.value ?? 'phase unknown'}</span>
        <span style={muted}>revision {data.revision}</span>
        {isLive
          ? (
            <span
              style={badge('var(--dsw-alias-state-success-primary)')}
              title="read from the host route just now, not reconstructed from this session’s tool traffic"
              data-autopilot-live=""
            >
              live
            </span>
            )
          : null}
        {data.stale
          ? (
            <span
              style={badge('var(--dsw-alias-state-warn-primary)')}
              title="the run advanced past the newest phase observation; gates below are last-observed, not current"
            >
              may have moved
            </span>
            )
          : null}
        {data.reinitSeqs.length > 0
          ? (
            <span
              style={badge('var(--dsw-alias-state-warn-primary)')}
              title={`autopilot_init was called again at seq ${data.reinitSeqs.join(', ')}; the engine refused it`}
            >
              re-init refused ×{data.reinitSeqs.length}
            </span>
            )
          : null}
      </div>

      {triage?.objective !== undefined
        ? <div style={{ marginBottom: 6 }}>{triage.objective}</div>
        : null}

      <div style={grid}>
        <Field label="plan gate" at={data.planGate} />
        <Field label="execution gate" at={data.executionGate} />
        <Field label="plan revision" at={data.planRevision} />
        <Field label="required roles" at={data.requiredRoles} />
        <Field label="replan budget" at={data.replanBudgetRemaining} />
        <Field label="log entries" at={data.logCount} />
      </div>

      {triage !== undefined
        ? (
          <div style={{ ...muted, marginTop: 6 }}>
            {[triage.size, triage.risk, triage.executionMode, triage.auditMode]
              .filter((v): v is string => typeof v === 'string').join(' · ')}
            {triage.touchesOperatingLayer === true ? ' · touches operating layer' : ''}
            {triage.acceptanceCriteria !== undefined
              ? ` · ${triage.acceptanceCriteria.length} acceptance criteria`
              : ''}
          </div>
          )
        : null}

      {data.executor !== undefined
        ? (
          <div style={{ ...muted, marginTop: 6 }} data-autopilot-executor>
            {'executor '}
            <span style={{ color: 'var(--dsw-alias-label-primary)' }}>
              {executorLine(data.executor.value)}
            </span>
            <span title={`observed at revision ${data.executor.revision}`}>
              {` @r${data.executor.revision}`}
            </span>
          </div>
          )
        : null}

      {data.audits.length > 0
        ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
            {data.audits.map(row => <AuditRow key={row.callId} row={row} />)}
          </ul>
          )
        : null}

      <div style={{ ...muted, marginTop: 6 }}>
        {data.calls.length} autopilot call{data.calls.length === 1 ? '' : 's'}
        {data.calls.some(c => c.failed) ? ` · ${data.calls.filter(c => c.failed).length} errored` : ''}
        {data.runId === undefined ? ' · run id not reported' : ''}
        {/*
          The provenance line has to move with the data, or it becomes the
          card's own false statement. Gates and revision come from the route
          when a live answer is in play; the audit rows, the call strip and the
          triage block are STILL the session-log reconstruction in both cases,
          because the route serves none of them.
        */}
        {isLive
          ? ' · gates read live from the host route; audits and triage reconstructed from this session’s tool traffic'
          : ' · reconstructed from this session’s tool traffic'}
      </div>
    </div>
  )
}
