/**
 * THE PROPERTY-ANALYSIS WORKFLOW, as an explicit state machine.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────
 *
 * The panel inferred everything from button labels. It usually said
 * "Re-analyze", which told the operator nothing about whether anything was
 * running, whether it had finished, or — most seriously — whether the
 * accepted analysis had ever been near a vision model at all. A mock run
 * and a live Gemini run produced visually identical results.
 *
 * That last one is the dangerous case. An analysis drives camera movement
 * in a video marketing someone's home. "Did a real model actually look at
 * these photographs?" must be answerable from the panel, not from logs.
 *
 * ── WHY A STATE, NOT A SET OF BOOLEANS ───────────────────────────────
 *
 * `analyzing && !failed && hasDraft` is four booleans and eleven illegal
 * combinations. One state is one answer, and the UI renders it.
 */

export type AnalysisWorkflowState =
  /** Nothing has ever been analyzed and no analyzer can run. */
  | 'not-analyzed'
  /** No accepted analysis, but an analyzer is configured and ready. */
  | 'ready-to-analyze'
  /** The paid confirmation is on screen. Nothing has been sent. */
  | 'confirming'
  /** A request is in flight. */
  | 'analyzing'
  /** A result came back and is waiting for a human decision. */
  | 'draft-ready'
  /** An analysis has been accepted and is driving the planner. */
  | 'accepted'
  /** The last attempt failed. */
  | 'failed'

export interface WorkflowInputs {
  hasAcceptedAnalysis: boolean
  hasDraft: boolean
  isRunning: boolean
  isConfirming: boolean
  lastError: string | null
  analyzerReady: boolean
}

/**
 * Order matters, and it is not arbitrary.
 *
 * In-flight beats everything: while a request is out, that is the only
 * thing the operator needs to know. A draft beats an accepted analysis,
 * because a draft is a decision someone owes. An error beats "ready",
 * because otherwise a failure would silently look like an idle panel.
 */
export function analysisWorkflowState(input: WorkflowInputs): AnalysisWorkflowState {
  if (input.isRunning) return 'analyzing'
  if (input.isConfirming) return 'confirming'
  if (input.hasDraft) return 'draft-ready'
  if (input.lastError) return 'failed'
  if (input.hasAcceptedAnalysis) return 'accepted'
  return input.analyzerReady ? 'ready-to-analyze' : 'not-analyzed'
}

// ── Which analyzer, and is it actually going to do anything ────────────

/**
 * How a result was produced.
 *
 * `mock` and `dry-run` are kept apart from `live` deliberately and
 * everywhere. They are useful, they are free, and they must never be
 * mistaken for a model having looked at the photographs.
 */
export type AnalyzerMode = 'live' | 'dry-run' | 'mock' | 'manual' | 'unconfigured'

export interface AnalyzerStatus {
  analyzerId: string
  displayName: string
  provider: string
  model: string | null
  mode: AnalyzerMode
  /** True when running it sends a billable request. */
  incursCost: boolean
  /** Whether an API key is stored. Never the key. */
  hasApiKey: boolean
  /** The per-provider safety lock. */
  allowLive: boolean
  imageCount: number
  /**
   * The provider has retired this model id.
   *
   * Checked BEFORE a request rather than discovered as a 404 afterwards.
   * A project configured before a model was retired still holds the old id
   * in its settings, and sending to it costs an attempt and returns a raw
   * JSON blob — so the panel refuses first and says what to change.
   */
  modelRetired?: boolean
  /** The replacement, when the provider has named a verified one. */
  recommendedModel?: string | null
}

export interface AnalyzerPresentation {
  /** e.g. "Gemini 2.5 Flash · Live" */
  label: string
  mode: AnalyzerMode
  /** One line under the label saying what will actually happen. */
  note: string
  /** False when pressing Analyze cannot produce an analysis. */
  canRun: boolean
  /** Why not, in words the operator can act on. */
  blocker: string | null
  /** What the primary button should do. */
  action: 'analyze' | 'configure'
  /** True when a confirmation dialog is mandatory before sending. */
  requiresConfirmation: boolean
}

/**
 * What the panel says about the configured analyzer.
 *
 * ── NO SILENT FALLBACK ───────────────────────────────────────────────
 *
 * A missing key does NOT quietly become a mock run, and a locked provider
 * does NOT quietly become a dry run. Either would hand back something that
 * looks like an analysis and is not one — the operator would accept it,
 * and it would go on to plan camera movement through rooms nobody looked
 * at. So the button stops being Analyze and becomes Configure.
 */
export function analyzerPresentation(status: AnalyzerStatus): AnalyzerPresentation {
  const model = status.model ?? status.displayName

  if (!status.incursCost) {
    // Local analyzers. Free, useful, and never dressed up as AI.
    const isMock = status.analyzerId === 'mock'
    return {
      label: `${status.displayName} — no AI request`,
      mode: isMock ? 'mock' : 'manual',
      note: isMock
        ? 'Produces a placeholder structure locally. Nothing is sent, and this is not a vision-model analysis.'
        : 'Rooms and relationships you enter by hand. Nothing is sent.',
      canRun: true,
      blocker: null,
      action: 'analyze',
      requiresConfirmation: false
    }
  }

  if (status.modelRetired) {
    // Ahead of the key and lock checks on purpose: a retired model fails
    // no matter how well everything else is configured, and telling
    // someone to check their key when the model is the problem sends them
    // to the wrong screen.
    return {
      label: `${model} — unavailable`,
      mode: 'unconfigured',
      note: status.recommendedModel
        ? `The provider has retired this model and recommends ${status.recommendedModel}. Change it in Advanced before analysing.`
        : 'The provider has retired this model. Choose a current one in Advanced before analysing.',
      canRun: false,
      blocker: 'Configured Gemini model is unavailable',
      action: 'configure',
      requiresConfirmation: false
    }
  }

  if (!status.hasApiKey) {
    return {
      label: `${model} — not configured`,
      mode: 'unconfigured',
      note: 'No API key is stored for this analyzer.',
      canRun: false,
      blocker: `${status.displayName} is not configured`,
      action: 'configure',
      requiresConfirmation: false
    }
  }

  if (!status.allowLive) {
    // The lock is off. Dry Run is still available and honest about itself,
    // but the operator asked for a paid analyzer, so the panel says why it
    // will not run one rather than silently downgrading.
    return {
      label: `${model} · Locked`,
      mode: 'unconfigured',
      note: 'The safety lock for live analysis is off. Turn it on in Settings to run a real analysis.',
      canRun: false,
      blocker: 'Live analysis is locked',
      action: 'configure',
      requiresConfirmation: false
    }
  }

  if (status.mode === 'dry-run') {
    return {
      label: `${model} · Dry Run`,
      mode: 'dry-run',
      note: 'No request will be sent. Every image is validated and the exact request is built, then discarded.',
      canRun: true,
      blocker: null,
      action: 'analyze',
      requiresConfirmation: false
    }
  }

  return {
    label: `${model} · Live`,
    mode: 'live',
    note: `All ${status.imageCount} project images are sent to ${status.provider} in one request. This costs money.`,
    canRun: true,
    blocker: null,
    action: 'analyze',
    // The one-shot token gate in main enforces this regardless; the flag
    // is what makes the renderer open the dialog rather than submit.
    requiresConfirmation: true
  }
}

// ── Provenance ─────────────────────────────────────────────────────────

/**
 * WHERE AN ACCEPTED ANALYSIS CAME FROM.
 *
 * Persisted WITH the analysis document, not alongside it, so it cannot
 * drift from the thing it describes and cannot be lost by a settings
 * change. The question it exists to answer is "was this actually analyzed
 * by Gemini?", and it has to survive a restart to answer it.
 */
export interface AnalysisProvenance {
  analyzerId: string
  displayName: string
  provider: string
  model: string | null
  mode: AnalyzerMode
  imageCount: number
  analyzedAt: number
  /** Set when a human accepts the draft. Null while it is still a draft. */
  acceptedAt: number | null
}

/** The one-line answer to "was this real?" */
export function provenanceLabel(p: AnalysisProvenance | null | undefined): string {
  if (!p) return 'Manual — entered by hand'
  const name = p.model ?? p.displayName
  switch (p.mode) {
    case 'live':
      return `${name} · Live`
    case 'dry-run':
      return `${name} · Dry Run — no request was sent`
    case 'mock':
      return `${p.displayName} — mock, no AI request`
    default:
      return 'Manual — entered by hand'
  }
}

/**
 * True only when a real vision model actually looked at the photographs.
 *
 * Used to mark everything else plainly, so a mock structure can never be
 * mistaken for one.
 */
export function isRealAnalysis(p: AnalysisProvenance | null | undefined): boolean {
  return p?.mode === 'live'
}

/** "30 images · analyzed 13:42" */
export function provenanceDetail(
  p: AnalysisProvenance | null | undefined,
  formatTime: (ms: number) => string
): string {
  if (!p) return 'No analyzer has run on this project.'
  const parts = [`${p.imageCount} image${p.imageCount === 1 ? '' : 's'}`]
  parts.push(`analyzed ${formatTime(p.analyzedAt)}`)
  if (p.acceptedAt) parts.push(`accepted ${formatTime(p.acceptedAt)}`)
  return parts.join(' · ')
}
