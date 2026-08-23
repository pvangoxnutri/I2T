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

  console.log('\n── probe complete ─────────────────────────────────')
}
