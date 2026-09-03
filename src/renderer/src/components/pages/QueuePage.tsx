import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppState'
import type { JobClipStatus, JobKind, JobStatus, QueueJob } from '../../types'
import { formatPrice } from '../../../../shared/pricing'
import { canResumeProviderTask } from '../../../../shared/generationState'

/** The provider status written when our status path turns out to be wrong.
 * Mirrors STATUS_ENDPOINT_UNVERIFIED in the generation service. */
const STATUS_ENDPOINT_UNVERIFIED = 'status-endpoint-unverified'

const STATUS_LABEL: Record<JobStatus, string> = {
  scheduled: 'Scheduled',
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const KIND_LABEL: Record<JobKind, string> = {
  'ai-generation': 'AI transitions',
  transitions: 'AI transitions',
  assembly: 'Video assembly',
  'preview-export': 'Preview export (watermarked)',
  'final-export': 'Final export'
}

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`
  return `${bytes} B`
}

/** Remote-task words that mean the provider finished rendering. Matches the
 * generation service's own succeeded test, so the two never disagree. */
function remoteSucceeded(providerStatus: string | null | undefined): boolean {
  return /succe|complete|finish/i.test(providerStatus ?? '')
}

function JobRow({ job, canReorder }: { job: QueueJob; canReorder: boolean }): React.JSX.Element {
  const waiting = job.status === 'queued' || job.status === 'scheduled'
  const [copied, setCopied] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [clips, setClips] = useState<JobClipStatus[]>([])
  const [playing, setPlaying] = useState<string | null>(null)

  // A remote task id means a PAID task exists provider-side. It stays
  // visible for the whole life of the job, in every status.
  const taskId = job.provider?.providerTaskId ?? null
  const providerName =
    job.provider?.provider === 'fal'
      ? 'fal.ai'
      : job.provider?.provider === 'kling'
        ? 'Kling'
        : null
  const endpointUnverified = job.provider?.providerStatus === STATUS_ENDPOINT_UNVERIFIED

  // What this job actually produced. Re-read whenever the job moves, so a
  // clip that lands mid-poll shows up without a restart.
  const isGeneration = job.kind === 'ai-generation' || job.kind === 'transitions'
  useEffect(() => {
    if (!isGeneration) return
    let cancelled = false
    void window.f2f.queue.clips(job.id).then((list) => {
      if (!cancelled) setClips(list)
    })
    return () => {
      cancelled = true
    }
  }, [isGeneration, job.id, job.status, job.progressPct, job.completedAt])

  const withClip = clips.filter((c) => c.exists)
  const clipsReady = clips.length > 0 && withClip.length === clips.length

  /**
   * What WE pay the provider for THIS generation attempt.
   *
   * Only generation jobs have one: an FFmpeg export costs us nothing per
   * run, so it shows an em dash rather than borrowing the customer price
   * and pretending that was a production cost.
   *
   * "actual" is preferred once the provider has confirmed the charge;
   * before that it is explicitly labelled an estimate, so nobody
   * reconciles an estimate against an invoice by mistake. Credits are the
   * real unit for Kling and are shown as credits — never converted to
   * money, and never converted to SEK.
   */
  const generationCost = ((): { value: string; title: string } => {
    if (!isGeneration) {
      return {
        value: '—',
        title: 'Export jobs run locally through FFmpeg — no provider is charged.'
      }
    }
    if (job.provider?.dryRun) {
      return { value: '—', title: 'Dry run — no request is sent, so nothing is charged.' }
    }
    const money = job.provider?.actualCost ?? job.provider?.estimatedCost ?? null
    const credits = job.provider?.actualCredits ?? job.provider?.estimatedCredits ?? null
    const isActual = job.provider?.actualCost != null || job.provider?.actualCredits != null
    const suffix = isActual ? 'actual' : 'estimated'
    if (money != null) {
      // fal.ai bills USD. Kept in USD deliberately — no FX is invented.
      return {
        value: `$${money.toFixed(2)} ${suffix}`,
        title: `What this generation attempt costs us, in the provider's own currency (${suffix}).`
      }
    }
    if (credits != null) {
      return {
        value: `${credits} credits ${suffix}`,
        title: `Kling bills in credits and publishes no credit→money rate, so this stays in credits (${suffix}).`
      }
    }
    return {
      value: 'unavailable',
      title: 'No verified rate for this provider/model combination.'
    }
  })()

  // THE RECOVERABLE STATE: the provider rendered and was paid, but the file
  // never made it to disk. Calling that "Completed" would hide a job that
  // still owes the customer a video — and its fix is a free re-download, not
  // a second paid generation.
  const downloadPending =
    isGeneration &&
    taskId !== null &&
    remoteSucceeded(job.provider?.providerStatus) &&
    clips.length > 0 &&
    withClip.length === 0 &&
    job.status !== 'processing' &&
    !waiting

  // Polling has nothing left to learn once the task is done AND the media is
  // here. Offering it then just invites pointless requests.
  //
  // Nor when the provider REFUSED the request. History showed "Resume
  // polling" on every row that had ever been given a task id, so a 422
  // rejection — where that id is dead — read as recoverable and led back
  // to the same rejection. `canResumeProviderTask` is the same decision
  // the editor makes, so the two views cannot disagree about whether a
  // task is still worth tracking.
  const canResumePolling =
    canResumeProviderTask(job.provider, job.note) &&
    !waiting &&
    job.status !== 'processing' &&
    !clipsReady

  return (
    <article className={`queue-row status-${job.status}`}>
      <div className="queue-row-main">
        <div className="queue-row-title">
          <span className="queue-row-project">{job.projectName}</span>
          <span className="queue-row-kind">{KIND_LABEL[job.kind]}</span>
          {providerName && <span className="queue-row-provider">{providerName}</span>}
          {job.metadata?.mock && <span className="queue-row-mock">awaiting provider</span>}
        </div>
        <div className="queue-row-meta">
          {job.transitionCount} transitions · created {timeAgo(job.createdAt)}
          {job.scheduledFor ? ` · runs ${formatWhen(job.scheduledFor)}` : ''}
          {job.note ? <span className="queue-row-note"> — {job.note}</span> : null}
          {job.status === 'completed' && job.outputPath ? (
            <span className="queue-row-output" title={job.outputPath}>
              {' '}
              — {job.outputPath}
            </span>
          ) : null}
        </div>
        {/* The remote task id — the only handle on a paid generation if our
            status path is wrong. Always visible once it exists. */}
        {taskId && (
          <div className="queue-task">
            <span className="queue-task-label">{providerName ?? 'Remote'} task</span>
            <code className="queue-task-id" title={taskId}>
              {taskId}
            </code>
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              onClick={() =>
                void window.f2f.queue.copyTaskId(job.id).then((id) => {
                  if (id) {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1600)
                  }
                })
              }
            >
              {copied ? 'Copied ✓' : 'Copy Task ID'}
            </button>
          </div>
        )}
        {endpointUnverified && (
          <p className="queue-endpoint-warning">
            Remote task submitted — status endpoint needs verification. The task is still running
            and was <strong>not</strong> resubmitted or cancelled. Correct the task-status path in
            Settings, then press Resume polling.
          </p>
        )}
        {downloadPending && (
          <p className="queue-endpoint-warning">
            {providerName ?? 'The provider'} finished rendering this generation, but the video was
            never downloaded to this machine. The remote task is kept —{' '}
            <strong>Retry download</strong> fetches it again and does <strong>not</strong> create a
            new paid generation.
          </p>
        )}
        {resumeError && <p className="queue-endpoint-warning">{resumeError}</p>}

        {/* The actual output. A generation the customer cannot watch is not
            finished work, so the clip lives on the job row itself rather than
            only inside the project editor. */}
        {clips.length > 0 && (
          <div className="queue-clips">
            {clips.map((clip) => (
              <div key={clip.pairKey} className="queue-clip">
                <div className="queue-clip-head">
                  <span className="queue-clip-label">{clip.label}</span>
                  {clip.exists ? (
                    <>
                      <span className="queue-clip-ok">
                        Clip ready · {formatBytes(clip.bytes)}
                        {clip.source === 'fal'
                          ? ' · fal.ai'
                          : clip.source === 'kling'
                            ? ' · Kling'
                            : ''}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-tiny"
                        onClick={() => setPlaying(playing === clip.pairKey ? null : clip.pairKey)}
                      >
                        {playing === clip.pairKey ? 'Hide clip' : 'View clip'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-tiny"
                        title="Reveal the video file in your file manager"
                        onClick={() =>
                          void window.f2f.clips.showInFolder(job.projectId, clip.storedName!)
                        }
                      >
                        Show in folder
                      </button>
                    </>
                  ) : (
                    <span className="queue-clip-missing">
                      {clip.storedName ? 'Clip file missing on disk' : 'No local clip'}
                    </span>
                  )}
                </div>
                {playing === clip.pairKey && clip.src && (
                  <video className="queue-clip-player" src={clip.src} controls autoPlay playsInline />
                )}
              </div>
            ))}
          </div>
        )}
        {job.status === 'processing' && (
          <div className="queue-progress">
            <div className="queue-progress-bar" style={{ width: `${job.progressPct}%` }} />
          </div>
        )}
      </div>

      <div className="queue-row-side">
        {/* TWO FIGURES, NEVER ONE.
            Customer value is revenue, frozen at queue time, in SEK.
            Generation cost is what WE pay the provider for THIS attempt,
            in the provider's currency. They are different directions and
            different currencies, so they are labelled and never summed —
            and neither is called just "Price". */}
        {job.price ? (
          <span
            className="queue-money queue-money-customer"
            title={`${job.price.imageCount} images × ${formatPrice(job.price.pricePerImage, job.price.currency)} — what the customer pays, frozen when the job was queued`}
          >
            <span className="queue-money-label">Customer value</span>
            <span className="queue-money-value">
              {formatPrice(job.price.totalPrice, job.price.currency)}
            </span>
          </span>
        ) : null}
        <span
          className="queue-money queue-money-generation"
          title={generationCost.title}
        >
          <span className="queue-money-label">Generation cost</span>
          <span className="queue-money-value">{generationCost.value}</span>
        </span>
        {/* A job whose media never downloaded is NOT "Completed" — the
            remote render succeeded, the delivery did not. */}
        <span
          className={`status-chip status-chip-${downloadPending ? 'scheduled' : job.status}`}
          title={downloadPending ? 'The remote task succeeded; the download did not' : undefined}
        >
          {downloadPending
            ? 'Download pending'
            : job.status === 'processing'
              ? `${STATUS_LABEL[job.status]} · ${job.progressPct}%`
              : STATUS_LABEL[job.status]}
        </span>
        {endpointUnverified && (
          <span className="status-chip status-chip-scheduled" title="The remote task is alive">
            Status endpoint unverified
          </span>
        )}
        <div className="queue-actions">
          {/* Free recovery: the state machine sees a succeeded task id and
              resolves to DOWNLOAD, so this can never resubmit or re-bill. */}
          {downloadPending && (
            <button
              type="button"
              className="btn btn-primary btn-tiny"
              title="Downloads the finished remote result again — no new paid generation"
              onClick={() => void window.f2f.queue.retry(job.id)}
            >
              Retry download
            </button>
          )}
          {canResumePolling && (
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              title="Keep tracking the existing remote task — never submits a new generation"
              onClick={() =>
                void window.f2f.queue.resumePolling(job.id).then((res) => {
                  setResumeError(res.ok ? null : res.reason)
                })
              }
            >
              Resume polling
            </button>
          )}
          {canReorder && waiting && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                title="Move earlier"
                onClick={() => void window.f2f.queue.reorder(job.id, 'up')}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-tiny"
                title="Move later"
                onClick={() => void window.f2f.queue.reorder(job.id, 'down')}
              >
                ↓
              </button>
            </>
          )}
          {(waiting || job.status === 'processing') && (
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              onClick={() => void window.f2f.queue.cancel(job.id)}
            >
              Cancel
            </button>
          )}
          {(job.status === 'failed' || job.status === 'cancelled') && !downloadPending && (
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              title={
                // The middle case is the one that used to lie: a task id
                // whose task the provider refused promises a free resume
                // it cannot deliver.
                taskId && canResumePolling
                  ? 'Re-queue with the original frozen price — the existing remote task is resumed, never resubmitted'
                  : taskId
                    ? 'The provider refused this request — re-queueing cannot recover it. Start a new generation from the project instead.'
                    : 'Re-queue with the original frozen price'
              }
              onClick={() => void window.f2f.queue.retry(job.id)}
            >
              Retry
            </button>
          )}
          {job.status === 'completed' && job.outputPath && (
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              onClick={() => void window.f2f.queue.reveal(job.outputPath!)}
            >
              Show in folder
            </button>
          )}
          {job.status !== 'processing' && !waiting && (
            <button
              type="button"
              className="btn btn-ghost btn-tiny"
              title="Remove from history"
              onClick={() => void window.f2f.queue.remove(job.id)}
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

export function QueuePage(): React.JSX.Element {
  const { queue, queuePaused } = useAppState()

  const scheduled = queue
    .filter((j) => j.status === 'scheduled')
    .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0))
  const active = queue
    .filter((j) => j.status === 'queued' || j.status === 'processing')
    .sort((a, b) => a.queueOrder - b.queueOrder)
  const history = queue
    .filter((j) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Queue</h1>
          <p className="page-subtitle">
            Production jobs across all projects. One FFmpeg render runs at a time; scheduled work
            starts automatically at its local time.
          </p>
        </div>
        <div className="queue-controls">
          {queuePaused && <span className="status-chip status-chip-failed">Queue paused</span>}
          <button
            type="button"
            className={`btn ${queuePaused ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() =>
              void (queuePaused ? window.f2f.queue.resume() : window.f2f.queue.pause())
            }
          >
            {queuePaused ? 'Resume Queue' : 'Pause Queue'}
          </button>
        </div>
      </header>

      <div className="queue-columns">
        <section>
          <h2 className="queue-group-title">Scheduled</h2>
          {scheduled.length === 0 ? (
            <p className="queue-empty">Nothing scheduled.</p>
          ) : (
            scheduled.map((j) => <JobRow key={j.id} job={j} canReorder />)
          )}
        </section>

        <section>
          <h2 className="queue-group-title">
            Active / Queued
            {queuePaused ? <span className="queue-paused-hint"> — paused, no new jobs start</span> : null}
          </h2>
          {active.length === 0 ? (
            <p className="queue-empty">Nothing queued right now.</p>
          ) : (
            active.map((j) => <JobRow key={j.id} job={j} canReorder />)
          )}
        </section>

        <section>
          <h2 className="queue-group-title">History</h2>
          {history.length === 0 ? (
            <p className="queue-empty">No finished jobs yet.</p>
          ) : (
            history.map((j) => <JobRow key={j.id} job={j} canReorder={false} />)
          )}
        </section>
      </div>
    </div>
  )
}
