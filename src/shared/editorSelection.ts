import { transitionKey } from './types'

/**
 * WHAT THE EDITOR IS LOOKING AT.
 *
 * ── ONE SELECTION, NOT THREE ─────────────────────────────────────────
 *
 * The editor used to hold `selectedPairKey`, `selectedImageId` and
 * `previewMode` as three independent pieces of state. Nothing kept them
 * agreeing, so clicking a photo left the previous transition's clip
 * playing while the inspector described a third thing. The user had to
 * work out which of the three the screen was actually about.
 *
 * A discriminated union makes the illegal states unrepresentable: an image
 * and a transition cannot both be selected, because there is only one
 * value. Preview mode and the inspector are DERIVED from it rather than
 * being told about it separately, so they cannot drift.
 *
 * `Full Video` is the one thing that is genuinely not about a selected
 * item, so it is its own selection rather than a mode sitting beside one.
 */

export type EditorSelection =
  | { kind: 'image'; imageId: string }
  | { kind: 'transition'; pairKey: string }
  | { kind: 'full' }

export const selectImage = (imageId: string): EditorSelection => ({ kind: 'image', imageId })
export const selectTransition = (pairKey: string): EditorSelection => ({
  kind: 'transition',
  pairKey
})
export const selectFullVideo = (): EditorSelection => ({ kind: 'full' })

export const selectedImageId = (s: EditorSelection): string | null =>
  s.kind === 'image' ? s.imageId : null
export const selectedPairKey = (s: EditorSelection): string | null =>
  s.kind === 'transition' ? s.pairKey : null

/** What the preview shows. One value, derived — never set independently. */
export type PreviewMode = 'image' | 'transition' | 'full'
export const previewModeFor = (s: EditorSelection): PreviewMode =>
  s.kind === 'image' ? 'image' : s.kind === 'transition' ? 'transition' : 'full'

/** Which bottom inspector is shown. */
export type InspectorMode = 'image' | 'transition' | 'none'
export const inspectorModeFor = (s: EditorSelection): InspectorMode =>
  s.kind === 'image' ? 'image' : s.kind === 'transition' ? 'transition' : 'none'

// ── Sequence-aware helpers ─────────────────────────────────────────────

/** The pair keys of a sequence, in order. */
export function pairKeysFor(imageIds: string[]): string[] {
  const keys: string[] = []
  for (let i = 0; i < imageIds.length - 1; i++) {
    keys.push(transitionKey(imageIds[i], imageIds[i + 1]))
  }
  return keys
}

/**
 * Keep a selection meaningful as the project changes.
 *
 * Images get removed and reordered. A selection pointing at something that
 * no longer exists must not leave the inspector describing a ghost — but
 * neither should every reorder dump the user back to Full Video. So a
 * still-present image keeps its selection (its POSITION may have changed,
 * which is fine — the user selected the photo, not the slot), and anything
 * genuinely gone falls back to Full Video.
 */
export function reconcileSelection(
  selection: EditorSelection,
  imageIds: string[]
): EditorSelection {
  if (selection.kind === 'image') {
    return imageIds.includes(selection.imageId) ? selection : selectFullVideo()
  }
  if (selection.kind === 'transition') {
    return pairKeysFor(imageIds).includes(selection.pairKey) ? selection : selectFullVideo()
  }
  return selection
}

// ── Keyboard navigation ────────────────────────────────────────────────

/**
 * What a keypress means in the editor.
 *
 * Returned as an intent rather than performed here, so the same decision
 * can be asserted in a test without a DOM, a React tree or a fake event.
 */
export type ShortcutAction =
  | { type: 'select-image'; imageId: string }
  | { type: 'move-image'; fromIndex: number; toIndex: number }
  | { type: 'none' }

const NONE: ShortcutAction = { type: 'none' }

/**
 * TYPING MUST NEVER MOVE A PHOTO.
 *
 * Arrow keys inside a prompt textarea move the caret; that is what the
 * user is doing, and hijacking it to reorder their sequence would be both
 * surprising and destructive. Editability is decided from the element
 * itself rather than from a focus flag someone has to remember to set.
 *
 * `contentEditable` is included because a rich-text control anywhere in
 * the app would otherwise silently fall through this guard.
 */
export function isEditableTarget(target: {
  tagName?: string
  isContentEditable?: boolean
  readOnly?: boolean
} | null): boolean {
  if (!target) return false
  if (target.isContentEditable === true) return true
  const tag = (target.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  // A read-only input cannot be typed into, so arrows there are navigation
  // rather than editing.
  if (tag === 'INPUT') return target.readOnly !== true
  return false
}

/**
 * Resolve a keypress against the current selection.
 *
 * Deliberately only acts on an IMAGE selection: arrow keys while a
 * transition is selected would need a second, different meaning, and two
 * meanings for one key is how a shortcut becomes a hazard.
 */
export function resolveShortcut(
  event: { key: string; shiftKey: boolean; ctrlKey?: boolean; target: Parameters<typeof isEditableTarget>[0] },
  selection: EditorSelection,
  imageIds: string[]
): ShortcutAction {
  if (isEditableTarget(event.target)) return NONE
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return NONE
  if (selection.kind !== 'image') return NONE

  const index = imageIds.indexOf(selection.imageId)
  if (index === -1) return NONE
  const delta = event.key === 'ArrowRight' ? 1 : -1
  const target = index + delta
  // Both ends are hard stops rather than wrapping. Wrapping would jump the
  // last photo to the front of the video on a keypress meant to nudge it.
  if (target < 0 || target >= imageIds.length) return NONE

  // Ctrl+Arrow (or Cmd+Arrow on Mac) reorders within the sequence.
  // Plain Arrow just navigates without modifying.
  return event.ctrlKey
    ? { type: 'move-image', fromIndex: index, toIndex: target }
    : { type: 'select-image', imageId: imageIds[target] }
}
