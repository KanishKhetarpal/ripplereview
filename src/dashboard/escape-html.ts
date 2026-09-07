/**
 * Escapes text for interpolation into HTML or SVG.
 *
 * Every string this dashboard prints comes from somewhere untrusted. A finding's summary
 * and rationale are written by a language model; file paths, symbol names and refs come
 * out of whatever repository was reviewed, and a branch name is attacker-controlled on any
 * public pull request. Rendering those into a page unescaped is a stored cross-site
 * scripting hole reachable by opening a pull request against a repository this tool
 * watches.
 *
 * One function, used for every interpolation, rather than escaping "the risky ones":
 * deciding per call site which strings are safe is how one gets missed.
 *
 * Quotes are escaped as well as angle brackets. They matter inside attribute values, and a
 * helper that is only correct in element text is a trap for whoever writes the next
 * attribute.
 */
const REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => REPLACEMENTS[character]);
}
