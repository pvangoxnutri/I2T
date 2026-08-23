import type { AiProviderConfig, AppSettings, ProviderId } from '../../shared/types'
import { getSettingsJson, saveSettingsJson } from '../db/projectsRepo'
import { sanitizeApiKey } from '../providers/keyHygiene'
import { FAL_MODEL_ID } from '../providers/fal/falConfig'

/**
 * The ONE write path for provider API keys.
 *
 * Two hard-won rules live here:
 *
 *  1. Keys are SANITISED on the way in (whitespace, newlines, surrounding
 *     quotes) — pasted baggage inside `Authorization: Key "…"` is a 401
 *     that looks exactly like a bad key.
 *
 *  2. A missing provider entry is CREATED, never silently skipped. The old
 *     map-only update dropped the key on the floor when the stored settings
 *     row predated the provider (e.g. a pre-fal row + "Save key" for fal),
 *     leaving the operator certain they had entered a key the app never
 *     stored.
 */
export function storeProviderApiKey(providerId: ProviderId, rawKey: string): boolean {
  const json = getSettingsJson()
  if (!json) return false
  const stored = JSON.parse(json) as AppSettings

  const apiKey = sanitizeApiKey(rawKey)
  const providers = stored.providers ?? []
  const existing = providers.find((p) => p.id === providerId)

  if (existing) {
    stored.providers = providers.map((p) => (p.id === providerId ? { ...p, apiKey } : p))
  } else {
    const fresh: AiProviderConfig = {
      id: providerId,
      label: providerId === 'fal' ? 'fal.ai' : providerId === 'kling' ? 'Kling' : providerId,
      apiKey,
      mode: 'dry-run',
      model: providerId === 'fal' ? FAL_MODEL_ID : null
    }
    stored.providers = [...providers, fresh]
  }

  saveSettingsJson(JSON.stringify(stored))
  return true
}

/** Whether a non-empty key is stored — never the key itself. */
export function hasProviderApiKey(providerId: ProviderId): boolean {
  const json = getSettingsJson()
  if (!json) return false
  const stored = JSON.parse(json) as AppSettings
  return Boolean(sanitizeApiKey(stored.providers?.find((p) => p.id === providerId)?.apiKey))
}
