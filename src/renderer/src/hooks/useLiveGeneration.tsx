import { useEffect, useState } from 'react'
import { LiveGenerateDialog } from '../components/editor/LiveGenerateDialog'
import type { FalModelOption, LiveConfirmationPayload } from '../../../preload/index'

/**
 * THE ONE PAID-GENERATION PATH IN THE RENDERER.
 *
 * ── WHY A HOOK AND NOT A SECOND COPY ─────────────────────────────────
 *
 * Generating costs money, and the sequence that protects that money is
 * exact: ask main for a confirmation payload, show the operator what it
 * will cost and whether the pair is even eligible, and only then submit
 * with the one-shot token. Every step is a guard.
 *
 * The Generation History drawer needed a Regenerate button, and the
 * obvious way to add one was to repeat those three calls there. Two
 * copies of a spending path is how one of them quietly loses a guard —
 * the preflight, the cost figure, or the refusal for a pair that is no
 * longer in the feed. So the inspector and the catalogue drive the same
 * hook, and there is nothing to keep in sync.
 *
 * ── IT DOES NOT DECIDE ANYTHING ──────────────────────────────────────
 *
 * Eligibility, price and readiness all come from main. This owns the
 * dialog and the two calls around it, nothing more; a pair main refuses
 * is presented as refused rather than filtered out here.
 */
export function useLiveGeneration(
  projectId: string,
  onFinished?: () => void
): {
  /** Opens the canonical confirmation for one pair. */
  open: (pairKey: string) => void
  /** Render this once in the component tree. */
  dialog: React.JSX.Element | null
  busy: boolean
} {
  // The pair is held BESIDE the payload, not read out of it: the
  // confirmation describes the transition in human terms and does not
  // carry the key, and submitting against a key derived from a label
  // would be a guess about which two photographs were being paid for.
  const [pending, setPending] = useState<{ pairKey: string; payload: LiveConfirmationPayload } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /**
   * The models an operator may pick, and the one chosen for THIS run.
   *
   * Per run, deliberately: the global default is where the dialog
   * starts, and changing it here does not change the default. Comparing
   * two models on one transition is the reason the selector exists, and
   * that must not require editing a preference.
   */
  const [models, setModels] = useState<FalModelOption[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)

  useEffect(() => {
    void window.f2f.generation.models().then(setModels)
  }, [])

  const open = (pairKey: string): void => {
    setSelectedModel(null)
    void window.f2f.generation.liveConfirmation(projectId, pairKey).then((data) => {
      // Null means main could not even build a confirmation — no project,
      // no provider. Nothing is opened rather than showing an empty shell.
      if (data) {
        setPending({ pairKey, payload: data })
        // Main resolved which model this run starts on — the global
        // default, or the one the previous generation used. The dropdown
        // begins there rather than at whatever happens to be first.
        setSelectedModel(data.modelId)
      }
    })
  }

  const dialog = pending ? (
    <LiveGenerateDialog
      data={pending.payload}
      busy={submitting}
      models={models}
      selectedModel={selectedModel ?? pending.payload.modelId}
      onSelectModel={(id) => {
        setSelectedModel(id)
        // Re-ask main so duration, resolution and cost describe the model
        // now selected. Recomputing any of that here would be a second
        // opinion about what the request will contain.
        void window.f2f.generation.liveConfirmation(projectId, pending.pairKey, id).then((data) => {
          if (data) setPending({ pairKey: pending.pairKey, payload: data })
        })
      }}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        setSubmitting(true)
        // THE CHOSEN MODEL REACHES THE SUBMIT. Without this the run
        // would silently use the global default however the dialog was
        // set — the exact hidden fallback this feature removes.
        void window.f2f.generation
          .generateLive(projectId, [pending.pairKey], selectedModel)
          .then(() => {
            setSubmitting(false)
            setPending(null)
            onFinished?.()
          })
      }}
    />
  ) : null

  return { open, dialog, busy: submitting }
}
