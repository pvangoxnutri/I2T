/**
 * Turning a Gemini HTTP failure into something a person can act on.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────
 *
 * A real 404 arrived looking like this:
 *
 *   {"error":{"code":404,"message":"models/gemini-2.5-flash is not found
 *    for API version v1beta ... This model is no longer available to new
 *    users. Please update your code to use models/gemini-3.6-flash",
 *    "status":"NOT_FOUND"}}
 *
 * Everything the operator needs is in there — the model is gone, and here
 * is its replacement — and none of it survives being pasted into an error
 * card as raw JSON. So the summary is short and actionable, the provider's
 * own text is kept separately for Details, and the recommended replacement
 * is extracted only when it can be read WITHOUT guessing.
 */

export type GeminiErrorCategory =
  | 'model-unavailable'
  | 'auth'
  | 'bad-request'
  | 'too-large'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'unknown'

export interface GeminiFailure {
  category: GeminiErrorCategory
  /** One line for the main card. Never contains raw provider JSON. */
  summary: string
  /** The provider's own text, for Details/Advanced. May be empty. */
  detail: string | null
  /** Only set when the provider NAMED a replacement. Never inferred. */
  recommendedModel: string | null
  retryable: boolean
}

/**
 * A model id the provider named as the replacement.
 *
 * ── DELIBERATELY STRICT ──────────────────────────────────────────────
 *
 * Only matched from an explicit "use models/<id>" instruction, and only
 * when the id looks like a Gemini model id. A looser pattern would happily
 * pull the RETIRED model out of the first half of the same sentence
 * ("models/gemini-2.5-flash is not found…") and confidently recommend the
 * thing that just failed.
 */
export function extractRecommendedModel(raw: string | null | undefined): string | null {
  if (!raw) return null
  // The id must END on an alphanumeric. Dots are legal INSIDE one
  // ("gemini-3.6-flash") which is exactly why a naive class swallows the
  // full stop that ends the sentence — the message reads
  // "...use models/gemini-3.6-flash. Call ListModels..." and the first
  // version of this returned "gemini-3.6-flash." with the period attached.
  const match = /use\s+(?:the\s+)?models\/([a-z0-9](?:[a-z0-9.\-_]{0,58}[a-z0-9])?)/i.exec(raw)
  return match ? match[1] : null
}

/** Whether the provider is saying the model itself is gone. */
export function isModelUnavailable(status: number | null, raw: string | null | undefined): boolean {
  if (status !== 404) return false
  if (!raw) return true
  return /no longer available|not found for api version|not supported for generatecontent|deprecat/i.test(
    raw
  )
}

/** Strip the provider body down to something safe to show. */
export function readableDetail(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Prefer the human message out of Google's error envelope; fall back to
  // the whole body, truncated. Either way, no key can survive.
  let text = trimmed
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } }
    if (typeof parsed.error?.message === 'string') text = parsed.error.message
  } catch {
    // Not JSON, or truncated JSON. The raw text is what we have.
  }
  return text
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, '[redacted]')
    .replace(/key=[^&\s"']+/gi, 'key=[redacted]')
    .slice(0, 400)
}

export function describeGeminiFailure(
  status: number | null,
  raw: string | null,
  configuredModel: string
): GeminiFailure {
  const detail = readableDetail(raw)

  if (isModelUnavailable(status, raw)) {
    const recommended = extractRecommendedModel(raw)
    return {
      category: 'model-unavailable',
      summary: recommended
        ? `Configured Gemini model is unavailable. The provider recommends ${recommended}.`
        : 'Configured Gemini model is unavailable',
      detail,
      recommendedModel: recommended && recommended !== configuredModel ? recommended : null,
      // Retrying the same id would fail identically. This needs a
      // configuration change, not another attempt.
      retryable: false
    }
  }

  if (status === 401 || status === 403) {
    return {
      category: 'auth',
      summary: 'Gemini refused the API key — check it in Settings',
      detail,
      recommendedModel: null,
      retryable: false
    }
  }
  if (status === 400) {
    return {
      category: 'bad-request',
      summary: 'Gemini rejected the request. This is a fault in the request we built, not the key.',
      detail,
      recommendedModel: null,
      retryable: false
    }
  }
  if (status === 413) {
    return {
      category: 'too-large',
      summary: 'The request was too large. Fewer or smaller images are needed.',
      detail,
      recommendedModel: null,
      retryable: false
    }
  }
  if (status === 429) {
    return {
      category: 'rate-limited',
      summary: 'Rate limited by Gemini. Nothing was analysed.',
      detail,
      recommendedModel: null,
      retryable: true
    }
  }
  if (status !== null && status >= 500) {
    return {
      category: 'server',
      summary: 'Gemini had a server error. Nothing was analysed.',
      detail,
      recommendedModel: null,
      retryable: true
    }
  }
  if (status === null) {
    return {
      category: 'network',
      summary: 'Could not reach Gemini',
      detail,
      recommendedModel: null,
      retryable: true
    }
  }
  return {
    category: 'unknown',
    summary: `Gemini request failed (${status})`,
    detail,
    recommendedModel: null,
    retryable: true
  }
}
