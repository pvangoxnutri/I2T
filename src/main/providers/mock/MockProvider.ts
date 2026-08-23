import {
  providerError,
  type CancelResult,
  type DryRunResult,
  type GenerationRequest,
  type ProviderMetadata,
  type SanitizedRequestPreview,
  type StatusResult,
  type SubmitResult,
  type ValidationResult,
  type VideoProvider
} from '../types'

/**
 * The development mock provider — the milestone-4 behaviour, now behind the
 * same interface as Kling. It exercises orchestration (queue, scheduling,
 * retry, recovery) and deliberately produces NO media: a transition without
 * a clip still has none when the job finishes.
 */
export class MockProvider implements VideoProvider {
  metadata(): ProviderMetadata {
    return {
      id: 'mock',
      label: 'Mock (development)',
      models: [
        {
          id: 'mock-start-end',
          label: 'Mock start + end frame',
          startFrame: true,
          endFrame: true,
          durationsSec: [2, 3, 4, 5, 6, 10],
          resolutions: ['720p', '1080p', '4K'],
          defaultResolution: '1080p',
          nativeAudio: false,
          confirmed: true,
          verificationNote: 'Local mock — no external API.'
        }
      ],
      supportsRemoteCancel: true
    }
  }

  validateConfiguration(): ValidationResult {
    return { ok: true }
  }

  validateRequest(request: GenerationRequest): ValidationResult {
    if (!request.startImagePath || !request.endImagePath) {
      return { ok: false, error: providerError('invalid-image', 'Both frames are required.') }
    }
    return { ok: true }
  }

  buildRequest(request: GenerationRequest): SanitizedRequestPreview {
    return {
      provider: 'mock',
      model: 'mock-start-end',
      endpoint: 'local://mock/generate',
      method: 'POST',
      headers: {},
      body: {
        prompt: request.prompt,
        start: request.startImageName,
        end: request.endImageName,
        duration: request.durationSec,
        resolution: request.resolution
      },
      display: {
        startImage: request.startImageName,
        endImage: request.endImageName,
        durationSec: request.durationSec,
        resolution: request.resolution
      },
      dryRun: true,
      warnings: ['Mock provider — orchestration only, never produces media.']
    }
  }

  dryRun(request: GenerationRequest): DryRunResult {
    return {
      dryRun: true,
      preview: this.buildRequest(request),
      estimatedCost: null,
      estimatedUsage: null
    }
  }

  async submitGeneration(): Promise<SubmitResult> {
    return {
      ok: false,
      error: providerError('not-configured', 'The mock provider never submits remote tasks.')
    }
  }

  async getGenerationStatus(): Promise<StatusResult> {
    return {
      ok: false,
      error: providerError('not-configured', 'The mock provider has no remote tasks to poll.')
    }
  }

  async cancelGeneration(): Promise<CancelResult> {
    return { ok: true }
  }

  async fetchResult(): Promise<{ ok: false; error: ReturnType<typeof providerError> }> {
    return {
      ok: false,
      error: providerError('not-configured', 'The mock provider produces no media to download.')
    }
  }

  estimateCost(): number | null {
    return null
  }

  /** The mock bills nothing — there is no unit to report. */
  estimateUsage(): null {
    return null
  }
}
