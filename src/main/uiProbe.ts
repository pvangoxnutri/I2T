import { BrowserWindow } from 'electron'

/**
 * UI PROBE (`electron . --f2f-uicheck`).
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────
 *
 * Two user-visible bugs — a transition click doing nothing, and a selected
 * image not appearing in the preview — both survived a careful reading of
 * the source. One was a lazily-written row treated as absence; the other
 * was a layout fault that put a correctly-loaded image 3000px off-screen.
 * Neither is visible in the code, and neither can be caught by a domain
 * test: the first needed the real component tree, the second needed real
 * layout. So this asks the running application instead, and reports the
 * measured boxes rather than whether an element exists.
 *
 * ── IT MUTATES NOTHING ───────────────────────────────────────────────
 *
 * Only selection controls are clicked, and selection changes no stored
 * state. It deliberately does NOT exercise reordering: an earlier version
 * did, and it silently changed the order of the operator's real project.
 * Reordering is covered by `testSequenceReorder` instead, where it costs
 * nobody their sequence.
 */
export async function runUiProbe(win: BrowserWindow): Promise<void> {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const js = <T>(script: string): Promise<T> => win.webContents.executeJavaScript(script, true)

  await wait(3500)

  // Open the first project.
  await js(`
    (() => {
      const card = document.querySelector('.project-card, .projects-list button, [class*="project"] button')
      if (card) card.click()
      return true
    })()
  `)
  await wait(2500)

  const report = async (label: string): Promise<void> => {
    const state = await js<Record<string, unknown>>(`
      (() => {
        const q = (s) => document.querySelector(s)
        const frame = q('.preview-frame')
        return {
          editorPresent: !!q('.editor'),
          timelineImages: document.querySelectorAll('.timeline-image').length,
          timelineTransitions: document.querySelectorAll('.timeline-transition').length,
          selectedImages: document.querySelectorAll('.timeline-image.is-selected').length,
          selectedTransitions: document.querySelectorAll('.timeline-transition.is-selected').length,
          previewContext: q('.preview-context') ? q('.preview-context').textContent : null,
          frameChildren: frame ? Array.from(frame.children).map((c) => c.tagName + '.' + c.className) : null,
          stillSrc: q('.preview-still') ? q('.preview-still').getAttribute('src') : null,
          stillComplete: q('.preview-still') ? q('.preview-still').complete + '/' + q('.preview-still').naturalWidth : null,
          stillBox: (() => {
            const el = q('.preview-still')
            if (!el) return null
            const r = el.getBoundingClientRect()
            const cs = getComputedStyle(el)
            return { w: Math.round(r.width), h: Math.round(r.height), objectFit: cs.objectFit, cssW: cs.width, cssH: cs.height }
          })(),
          frameBox: (() => {
            const el = q('.preview-frame')
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { w: Math.round(r.width), h: Math.round(r.height) }
          })(),
          stageBox: (() => {
            const el = q('.preview-stage')
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { w: Math.round(r.width), h: Math.round(r.height) }
          })(),
          videoSrc: q('.preview-video') ? q('.preview-video').getAttribute('src') : null,
          emptyTitle: q('.preview-empty-title') ? q('.preview-empty-title').textContent : null,
          inspectorHead: q('.inspector-pair') ? q('.inspector-pair').textContent : null,
          inspectorEmpty: q('.inspector-empty') ? q('.inspector-empty').textContent : null
        }
      })()
    `)
    console.log(`\n── ${label} ─────────────────────────────────`)
    for (const [k, v] of Object.entries(state)) {
      console.log(`  ${k.padEnd(22)}: ${JSON.stringify(v)}`)
    }
  }

  await report('AFTER OPENING PROJECT')

  // ── Click the first timeline image ───────────────────────────────────
  await js(`(() => { const b = document.querySelectorAll('.timeline-image')[0]; if (b) b.click(); return !!b })()`)
  await wait(900)
  await report('AFTER CLICKING IMAGE 1')

  // ── ArrowRight ───────────────────────────────────────────────────────
  await js(`
    (() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      return true
    })()
  `)
  await wait(900)
  await report('AFTER ArrowRight')

  // ── Click the first transition ───────────────────────────────────────
  await js(`(() => { const b = document.querySelectorAll('.timeline-transition')[0]; if (b) b.click(); return !!b })()`)
  await wait(900)
  await report('AFTER CLICKING TRANSITION 1→2')

  // ── Is Generate reachable from the preview itself? ───────────────────
  const generate = await js<string | null>(`
    (() => {
      const btns = Array.from(document.querySelectorAll('.preview-endpoints-mid button'))
      return btns.length ? btns[0].textContent : null
    })()
  `)
  console.log(`\n  preview Generate button : ${JSON.stringify(generate)}`)

  const endpointImgs = await js<number>(
    `document.querySelectorAll('.preview-endpoints figure img').length`
  )
  console.log(`  endpoint images shown   : ${endpointImgs}`)

  // ── Arrow keys must NOT move the image while a transition is selected ─
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  await wait(600)
  await report('ArrowRight WHILE TRANSITION SELECTED (must not change selection)')

  // ── Back to an image: the still must return ──────────────────────────
  await js(`(() => { document.querySelectorAll('.timeline-image')[4].click(); return true })()`)
  await wait(800)
  await report('AFTER CLICKING IMAGE 5 AGAIN')

  // ── Full Video mode still independent ────────────────────────────────
  await js(`
    (() => {
      const b = Array.from(document.querySelectorAll('.preview-mode'))
        .find((x) => x.textContent.includes('Full Video'))
      if (b) b.click()
      return !!b
    })()
  `)
  await wait(800)
  await report('AFTER Full Video')

  // ── Typing must never move a photo ───────────────────────────────────
  const typingGuard = await js<string>(`
    (() => {
      const img = document.querySelectorAll('.timeline-image')[2]
      img.click()
      const before = document.querySelector('.preview-context').textContent
      const ta = document.createElement('textarea')
      document.body.appendChild(ta)
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      const after = document.querySelector('.preview-context').textContent
      ta.remove()
      return before + ' -> ' + after
    })()
  `)
  console.log(`\n  arrow inside textarea   : ${JSON.stringify(typingGuard)}`)

  // ── Walking the sequence resolves a DIFFERENT photo each time ────────
  //
  // An off-by-one here would show the wrong room while looking entirely
  // correct, so the sources are compared rather than the headings.
  await js(`(() => { document.querySelectorAll('.timeline-image')[0].click(); return true })()`)
  await wait(700)
  const walk: string[] = []
  for (let i = 0; i < 4; i++) {
    walk.push(await js<string>(`document.querySelector('.preview-still').getAttribute('src')`))
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
    await wait(600)
  }
  console.log('\n── WALKING THE SEQUENCE ───────────────────────────────────')
  console.log(`  distinct sources over 4 steps: ${new Set(walk).size} of ${walk.length}`)

  // ── THE ANALYSIS PANEL ───────────────────────────────────────────────
  const analysis = await js<Record<string, unknown>>(`
    (() => {
      const tab = Array.from(document.querySelectorAll('.left-tab'))
        .find((t) => t.textContent.trim() === 'Analysis')
      if (tab) tab.click()
      return true
    })()
  `)
  void analysis
  await wait(1200)

  const panel = await js<Record<string, unknown>>(`
    (() => {
      const q = (s) => document.querySelector(s)
      const t = (s) => (q(s) ? q(s).textContent.trim() : null)
      return {
        head: t('.analysis-summary-head'),
        sub: t('.analysis-summary-sub'),
        analyzerLabel: t('.analyzer-status-label'),
        analyzerScope: t('.analyzer-status-scope'),
        analyzerNote: t('.analyzer-status-note'),
        analyzerModeClass: q('.analyzer-status') ? q('.analyzer-status').className : null,
        provenance: t('.analysis-provenance'),
        helper: t('.analysis-summary-helper'),
        primaryButton: q('.analysis-summary-actions button')
          ? q('.analysis-summary-actions button').textContent.trim()
          : null,
        primaryDisabled: q('.analysis-summary-actions button')
          ? q('.analysis-summary-actions button').disabled
          : null,
        buttons: Array.from(document.querySelectorAll('.analysis-summary-actions button'))
          .map((b) => b.textContent.trim())
      }
    })()
  `)
  console.log('\n── ANALYSIS PANEL ─────────────────────────────────────────')
  for (const [k, v] of Object.entries(panel)) {
    console.log(`  ${k.padEnd(20)}: ${JSON.stringify(v)}`)
  }

  // ── SWITCH TO GEMINI AND SEE WHAT THE PANEL SAYS ─────────────────────
  //
  // Selecting an analyzer changes no stored state; it is local panel
  // state. Nothing is sent.
  await js(`
    (() => {
      const adv = Array.from(document.querySelectorAll('.analysis-summary-actions button'))
        .find((b) => b.textContent.includes('Advanced'))
      if (adv) adv.click()
      return true
    })()
  `)
  await wait(900)
  const switched = await js<string | null>(`
    (() => {
      const sel = document.querySelector('.analysis-advanced select')
      if (!sel) return null
      const opt = Array.from(sel.options).find((o) => /gemini/i.test(o.textContent))
      if (!opt) return 'no gemini option'
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return opt.textContent
    })()
  `)
  await wait(1400)
  const gemini = await js<Record<string, unknown>>(`
    (() => {
      const q = (s) => document.querySelector(s)
      const t = (s) => (q(s) ? q(s).textContent.trim() : null)
      return {
        analyzerLabel: t('.analyzer-status-label'),
        analyzerNote: t('.analyzer-status-note'),
        modeClass: q('.analyzer-status') ? q('.analyzer-status').className : null,
        buttons: Array.from(document.querySelectorAll('.analysis-summary-actions button'))
          .map((b) => b.textContent.trim() + (b.disabled ? ' [disabled]' : ''))
      }
    })()
  `)
  console.log(`\n── AFTER SELECTING ${JSON.stringify(switched)} ──────────────`)
  for (const [k, v] of Object.entries(gemini)) {
    console.log(`  ${k.padEnd(20)}: ${JSON.stringify(v)}`)
  }

  // ── THE REBUILD DIALOG ───────────────────────────────────────────────
  //
  // Opens the dialog and READS it. Cancel is clicked afterwards; nothing
  // is rebuilt and nothing is written.
  await js(`
    (() => {
      const b = Array.from(document.querySelectorAll('.analysis-advanced button'))
        .find((x) => /Rebuild transition prompts/i.test(x.textContent))
      if (b) b.click()
      return !!b
    })()
  `)
  await wait(1200)
  const dialog = await js<Record<string, unknown>>(`
    (() => {
      const q = (s) => document.querySelector(s)
      const t = (s) => (q(s) ? q(s).textContent.trim() : null)
      return {
        title: t('.dialog-title'),
        total: t('.rebuild-total'),
        mockWarning: t('.rebuild-mock-warning'),
        summary: Array.from(document.querySelectorAll('.rebuild-summary li')).map((l) =>
          l.textContent.trim()
        ),
        listed: document.querySelectorAll('.rebuild-list li').length,
        ack: t('.rebuild-mock-ack'),
        confirmLabel: (() => {
          const b = Array.from(document.querySelectorAll('.dialog-actions button')).pop()
          return b ? b.textContent.trim() + (b.disabled ? ' [disabled]' : '') : null
        })()
      }
    })()
  `)
  console.log('\n── REBUILD DIALOG ─────────────────────────────────────────')
  for (const [k, v] of Object.entries(dialog)) {
    console.log(`  ${k.padEnd(14)}: ${JSON.stringify(v)}`)
  }
  // Close it without rebuilding.
  await js(`
    (() => {
      const b = Array.from(document.querySelectorAll('.dialog-actions button'))
        .find((x) => x.textContent.trim() === 'Cancel')
      if (b) b.click()
      return true
    })()
  `)

  console.log('\n── probe complete ─────────────────────────────────')
}
