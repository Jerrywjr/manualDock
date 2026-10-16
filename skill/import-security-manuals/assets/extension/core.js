/** Compatibility entry for shared identity helpers and the export API. */
export { normalizeURL, mergeLinks, validateLocator, chapterKey } from './sangfor-rules.js';
export { buildExports, hasMissingExamples } from './exports.js';

/** Exact UTF-8 SHA-256. Duplicate normalization, if desired, belongs to the caller. */
export async function contentHash(text) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(text ?? '')),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
