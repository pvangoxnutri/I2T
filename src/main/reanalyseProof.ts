import { listProjects } from './db/projectsRepo'
import { getSettingsJson } from './db/projectsRepo'
import { analysePair, acceptPairAnalysis } from './services/pairAnalysisService'
import { buildGenerationRequest } from './services/generationService'
import { finalizeTransitionPromptById } from './services/promptFinalizer'
import { getFeedSequenceIds } from '../shared/feedSequence'
import { transitionKey } from '../shared/types'
import { PROMPT_MAX_CHARS, PRESET_PARTS, MOTION_HEADER } from '../shared/prompts'
import { containsTempoClaim } from '../shared/motionInstructionHygiene'

/**
 * END-TO-END PROOF THAT RE-ANALYSE FINISHES THE CANONICAL WAY.
 *
 * `electron . --f2f-reanalyse-proof --user-data-dir=<copy>`
 *
 * ── WHY A REAL RUN AND NOT A UNIT TEST ───────────────────────────────
 *
 * The smoke suite proves the four paths agree on a fixture project. This
 * runs the actual Re-analyse workflow — the real analyzer class, the
 * real parser, the real acceptance, the real persistence — against the
 * operator's own data, and then asks the paid path what it would send.
 * The divergence being fixed was invisible to type checking and lived
 * between services, which is exactly the gap a fixture can miss.
 *
 * NO PAID CALL IS MADE. The analyzer's `fetchImpl` is replaced with a
 * function that returns a canned Gemini body, so the network is never
 * touched and no key is needed. Point it at a COPY of the database:
 * accepting an analysis WRITES.
 */

/** A Gemini pair response, worded the way a language model words things. */
function fakeGeminiResponse(motionInstruction: string): string {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                relation: 'same-room',
                roomLabel: 'Living Area',
                sharedLandmarks: ['the dark L-shaped sofa'],
                openings: [],
                reflectiveSurfaces: [],
                geometryConflicts: [],
                missingContext: [],
                motionInstruction
              })
            }
          ]
        }
      }
    ]
  })
}

export async function runReanalyseProof(): Promise<number> {
  const say = (s: string): void => console.log(`[reanalyse-proof] ${s}`)

  const project = listProjects()[0]
  if (!project) {
    say('no project in this database')
    return 1
  }
  const feed = getFeedSequenceIds(project)
  if (feed.length < 2) {
    say('feed has fewer than two images')
    return 1
  }

  // A pair with a stored prompt that is NOT hand-written — those are the
  // ones an acceptance rebuilds. A manual prompt is deliberately held
  // rather than overwritten, so measuring the rebuild on one would be
  // measuring the protection instead.
  const feedPairs = feed.slice(0, -1).map((id, i) => transitionKey(id, feed[i + 1]))
  const isManual = (k: string): boolean =>
    project.transitions[k]?.promptProvenance?.manuallyEdited === true
  const pairKey =
    feedPairs.find((k) => (project.transitions[k]?.prompt ?? '').length > 0 && !isManual(k)) ??
    feedPairs[0]
  const manualPair = feedPairs.find((k) => isManual(k) && (project.transitions[k]?.prompt ?? '').length > 0)

  say(`project ${project.name} · pair ${pairKey.slice(0, 20)}…`)

  // ── BEFORE ──────────────────────────────────────────────────────────
  const before = listProjects().find((p) => p.id === project.id)!.transitions[pairKey]
  const beforePrompt = before?.prompt ?? ''
  say(`BEFORE  length=${beforePrompt.length} route="${before?.promptProvenance?.motionInstruction ?? '-'}"`)

  // ── RE-ANALYSE, WITH A CHANGED ROUTE AND A TEMPO CLAIM IN IT ────────
  //
  // Deliberately worded the way the real one was: "gently" is the tempo,
  // the rest is the finding.
  const NEW_ROUTE = 'rotate gently toward the balcony doors, keeping the dark L-shaped sofa in view'
  const run = await analysePair({
    projectId: project.id,
    pairKey,
    apiKey: 'not-a-real-key-no-request-is-made',
    model: 'fake',
    fetchImpl: (async () =>
      new Response(fakeGeminiResponse(NEW_ROUTE), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as unknown as Parameters<typeof analysePair>[0]['fetchImpl']
  })
  if (!run.ok) {
    say(`FAILED to analyse: ${run.reason}`)
    return 1
  }
  say(`analyzer decision=${run.record?.decision ?? '-'} reason="${run.record?.reason ?? '-'}"`)
  const accepted = acceptPairAnalysis(project.id, pairKey)
  if (!accepted.ok) {
    say(`FAILED to accept: ${accepted.reason}`)
    return 1
  }
  // WHY a rebuild may not have happened, stated rather than inferred.
  const afterRow = listProjects().find((p) => p.id === project.id)!.transitions[pairKey]
  say(
    `after accept: manuallyEdited=${afterRow?.promptProvenance?.manuallyEdited ?? '-'} ` +
      `suggestionHeld=${Boolean(afterRow?.promptSuggestion)} ` +
      `acceptedDecision=${accepted.record?.decision ?? '-'}`
  )

  // ── AFTER ───────────────────────────────────────────────────────────
  const after = listProjects().find((p) => p.id === project.id)!.transitions[pairKey]
  const afterPrompt = after?.prompt ?? ''
  say(`AFTER   length=${afterPrompt.length} route="${after?.promptProvenance?.motionInstruction ?? '-'}"`)

  const checks: Array<[string, boolean]> = []
  const motion = PRESET_PARTS.motionQuality
  const hasMotion = (p: string): boolean =>
    p.includes(motion.text) || (motion.compact != null && p.includes(motion.compact))

  checks.push(['new pair evidence is used (route changed)', beforePrompt !== afterPrompt])
  checks.push(['route mentions the new destination', /balcony doors/i.test(afterPrompt)])
  checks.push(['route keeps the held landmark', /L-shaped sofa/i.test(afterPrompt)])
  checks.push(['tempo claim removed from the route', !/gently/i.test(afterPrompt)])
  checks.push(['no tempo claim anywhere in the prompt', !containsTempoClaim(afterPrompt)])
  checks.push(['MOTION_QUALITY present verbatim', hasMotion(afterPrompt)])
  // NOT "unchanged from before". The stored prompt predates this
  // contract — it is 3398 characters of the previous one — so demanding
  // the new prompt match it would be demanding the fix not happen. What
  // must hold is that the motion block is the canonical constant, byte
  // for byte, rather than anything the analyzer or this path composed.
  say(`BEFORE carried the current MOTION_QUALITY: ${hasMotion(beforePrompt)}`)
  const motionLine = afterPrompt.split('\n\n').find((b) => b.startsWith('MOTION — ')) ?? ''
  checks.push([
    'MOTION_QUALITY is the canonical constant, byte for byte',
    motionLine === motion.text || motionLine === motion.compact
  ])
  checks.push([
    'section order canonical (route before occupancy)',
    afterPrompt.indexOf(MOTION_HEADER) >= 0 &&
      afterPrompt.indexOf(MOTION_HEADER) < afterPrompt.indexOf('SCENE OCCUPANCY')
  ])
  checks.push([`within the ${PROMPT_MAX_CHARS} character budget`, afterPrompt.length <= PROMPT_MAX_CHARS])
  checks.push([
    'provenance is current, not hand-written',
    after?.promptProvenance?.manuallyEdited === false &&
      (after?.promptProvenance?.plannedAt ?? 0) > 0
  ])
  checks.push([
    'provenance route matches what was sent',
    (after?.promptProvenance?.motionInstruction ?? '') === 'rotate toward the balcony doors, keeping the dark L-shaped sofa in view'
  ])

  // ── A HAND-WRITTEN PROMPT IS STILL PROTECTED ───────────────────────
  //
  // The same workflow, on a pair the operator worded themselves: the
  // analysis is accepted, a suggestion is held beside their text, and
  // their text is not touched.
  if (manualPair) {
    const theirs = listProjects().find((p) => p.id === project.id)!.transitions[manualPair].prompt
    const runManual = await analysePair({
      projectId: project.id,
      pairKey: manualPair,
      apiKey: 'not-a-real-key-no-request-is-made',
      model: 'fake',
      fetchImpl: (async () =>
        new Response(fakeGeminiResponse(NEW_ROUTE), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })) as unknown as Parameters<typeof analysePair>[0]['fetchImpl']
    })
    if (runManual.ok) acceptPairAnalysis(project.id, manualPair)
    const manualAfter = listProjects().find((p) => p.id === project.id)!.transitions[manualPair]
    checks.push(['a hand-written prompt is NOT overwritten', manualAfter.prompt === theirs])
    checks.push(['and a suggestion is held beside it', Boolean(manualAfter.promptSuggestion)])
    checks.push([
      'the held suggestion is itself canonical',
      hasMotion(manualAfter.promptSuggestion?.text ?? '') &&
        (manualAfter.promptSuggestion?.text ?? '').length <= PROMPT_MAX_CHARS
    ])
  } else {
    say('(no hand-written pair in this database to test protection on)')
  }

  // ── AND THE CANONICAL FINALIZER AGREES WITH WHAT WAS STORED ─────────
  const direct = finalizeTransitionPromptById(project.id, pairKey)
  checks.push(['finalizer reproduces the stored prompt', direct.ok && direct.prompt === afterPrompt])

  // ── WHAT REGENERATE WOULD ACTUALLY SEND ─────────────────────────────
  const settings = JSON.parse(getSettingsJson() ?? '{}')
  const built = buildGenerationRequest(project.id, pairKey, settings)
  checks.push([
    'Regenerate resolves exactly this prompt',
    built.ok && built.request.prompt === afterPrompt
  ])
  if (!built.ok) say(`  (request refused: ${built.reason})`)

  let failed = 0
  for (const [name, pass] of checks) {
    if (!pass) failed++
    say(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  }
  say(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
  return failed === 0 ? 0 : 1
}
