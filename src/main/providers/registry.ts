import type { AiProviderConfig, AppSettings, ProviderId } from '../../shared/types'
import type { FetchLike } from './kling/KlingClient'
import { KlingProvider } from './kling/KlingProvider'
import { FalProvider } from './fal/FalProvider'
import { MockProvider } from './mock/MockProvider'
import type { ProviderMetadata, VideoProvider } from './types'

/**
 * Provider construction in one place. Everything else asks for "the provider
 * for these settings" and gets the generic interface back.
 *
 * Each provider's live safety lock is read HERE from settings and handed to
 * the provider, so no call site can accidentally construct one that is
 * allowed to spend money — and unlocking fal.ai never unlocks Kling.
 */

/** Test-only transport override. Automated tests inject a mock so that no
 * real provider request can ever leave the suite. */
let testTransport: FetchLike | null = null

export function __setTestTransport(fetchImpl: FetchLike | null): void {
  testTransport = fetchImpl
}

export function createProvider(
  config: AiProviderConfig | undefined,
  settings?: AppSettings | null,
  fetchImpl?: FetchLike
): VideoProvider {
  if (!config || config.id === 'mock') return new MockProvider()

  // Anything unexpected falls back to the safe mode rather than opening the
  // network.
  const mode = config.mode === 'live' ? 'live' : 'dry-run'
  const transport = fetchImpl ?? testTransport ?? undefined

  if (config.id === 'fal') {
    return new FalProvider({
      apiKey: config.apiKey ?? '',
      mode,
      fetchImpl: transport,
      liveAllowed: settings?.production?.allowLiveFalRequests === true
    })
  }

  return new KlingProvider({
    apiKey: config.apiKey ?? '',
    mode,
    fetchImpl: transport,
    contract: settings?.production?.klingContract,
    liveAllowed: settings?.production?.allowLiveKlingRequests === true
  })
}

/** Capability catalogs for the Settings UI — no credentials involved. */
export function providerCatalog(settings?: AppSettings | null): ProviderMetadata[] {
  void settings
  return [
    new FalProvider({ apiKey: '', mode: 'dry-run' }).metadata(),
    new KlingProvider({ apiKey: '', mode: 'dry-run' }).metadata(),
    new MockProvider().metadata()
  ]
}

export function providerLabel(id: ProviderId): string {
  if (id === 'fal') return 'fal.ai'
  return id === 'kling' ? 'Kling' : 'Mock (development)'
}
