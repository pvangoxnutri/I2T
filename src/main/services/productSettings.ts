import { getSettingsJson, saveSettingsJson } from '../db/projectsRepo'
import { GEMINI_DEFAULT_MODEL } from '../analysis/providers/gemini/geminiConfig'
import { FAL_MODEL_ID } from '../providers/fal/falConfig'
import type { AppSettings } from '../../shared/types'

/**
 * THE PRODUCT DECISION, APPLIED TO STORED SETTINGS.
 *
 * ── WHAT CHANGED, AND WHY ────────────────────────────────────────────
 *
 * I2T generates video with fal.ai and analyses properties with Gemini.
 * That is not a preference the operator sets; it is what the product is.
 * Settings offered a provider dropdown, a Dry Run / Live mode, and a
 * separate production lock per provider — three controls describing the
 * same fact, all of which had to be correct before anything could be
 * generated, and any one of which silently disabled the app.
 *
 * The internal abstractions are untouched: providers are still pluggable,
 * `mode` still gates the network, and the locks still exist. What is gone
 * is asking the operator to configure them.
 *
 * ── LIVE IS DERIVED FROM THE KEY ─────────────────────────────────────
 *
 * A stored key IS the intent to send real requests — there is no reason
 * to enter one and then also promise you meant it. Spending is still
 * confirmed per generation, with the cost shown, which is where a
 * spending decision actually belongs. Remove the key and everything falls
 * back to dry-run on its own.
 *
 * Normalisation runs on WRITE (and once at startup) rather than on read,
 * so the renderer, the generation service and the analyzer all read the
 * same stored state instead of each applying the rule differently.
 */
export function normalizeProductSettings(settings: AppSettings): AppSettings {
  const providers = settings.providers ?? []
  const fal = providers.find((p) => p.id === 'fal')
  const falKey = (fal?.apiKey ?? '').trim().length > 0
  const geminiKey = (settings.analyzer?.apiKey ?? '').trim().length > 0

  return {
    ...settings,
    // Video is fal.ai. A settings row written when Kling was selectable
    // still points at fal from here on; its entry is left in place so no
    // stored key is destroyed by a product decision.
    activeProviderId: 'fal',
    providers: providers.map((p) =>
      p.id === 'fal'
        ? {
            ...p,
            mode: falKey ? ('live' as const) : ('dry-run' as const),
            model: p.model ?? FAL_MODEL_ID
          }
        : p
    ),
    analyzer: {
      ...(settings.analyzer ?? { analyzerId: 'gemini', model: GEMINI_DEFAULT_MODEL, apiKey: '' }),
      analyzerId: 'gemini',
      model: settings.analyzer?.model ?? GEMINI_DEFAULT_MODEL,
      mode: geminiKey ? ('live' as const) : ('dry-run' as const)
    },
    production: {
      ...settings.production,
      allowLiveFalRequests: falKey,
      allowLiveGeminiAnalysis: geminiKey
    }
  }
}

/** Applied once at startup so an existing install lands on the new rule. */
export function normalizeStoredSettings(): void {
  const json = getSettingsJson()
  if (!json) return
  try {
    const stored = JSON.parse(json) as AppSettings
    const normalized = normalizeProductSettings(stored)
    const before = JSON.stringify(stored)
    const after = JSON.stringify(normalized)
    if (before !== after) {
      saveSettingsJson(after)
      console.log('[settings] normalised to fal.ai + Gemini')
    }
  } catch (err) {
    // Never let settings housekeeping stop the app starting.
    console.error('[settings] could not normalise', err)
  }
}

/**
 * WHAT A SETTINGS SAVE FROM THE RENDERER IS ALLOWED TO CHANGE.
 *
 * Never a key. The renderer is not sent them and must not be able to
 * write them, so every key is carried over from what is already stored
 * and the incoming value is discarded whatever it says.
 *
 * Extracted from the IPC handler so the rule can be tested directly:
 * inline, the only way to exercise it was to run the whole app.
 */
export function mergeSettingsForSave(
  incoming: AppSettings,
  stored: AppSettings | null
): AppSettings {
  return normalizeProductSettings({
    ...incoming,
    providers: (incoming.providers ?? []).map((p) => {
      const previous = stored?.providers?.find((x) => x.id === p.id)
      return { ...p, apiKey: previous?.apiKey ?? '', legacySecret: previous?.legacySecret ?? '' }
    }),
    // ── THE API-KEY BUG ─────────────────────────────────────────────
    //
    // Provider keys were merged back from storage and the analyzer key
    // was not, so it was written from whatever the renderer sent — and
    // the renderer sends `apiKey: ''` on every analyzer patch. Changing
    // the Gemini model silently erased the stored key.
    analyzer: incoming.analyzer
      ? { ...incoming.analyzer, apiKey: stored?.analyzer?.apiKey ?? '' }
      : incoming.analyzer
  })
}
