/**
 * API-key hygiene, shared by every provider.
 *
 * A key pasted from a terminal, a password manager or a docs page often
 * arrives with invisible baggage — trailing newline, surrounding quotes,
 * tabs. Sent verbatim inside `Authorization: Key "abc..."` that baggage is
 * an instant 401 that LOOKS like a bad key. Sanitising is done both when a
 * key is stored and when a client is constructed, so an already-stored
 * dirty key is repaired at use time too.
 */
export function sanitizeApiKey(raw: string | null | undefined): string {
  let key = (raw ?? '').replace(/[\r\n\t]/g, '').trim()
  // Strip matching surrounding quotes from a careless copy-paste.
  while (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'")) ||
      (key.startsWith('`') && key.endsWith('`')))
  ) {
    key = key.slice(1, -1).trim()
  }
  return key
}
