/**
 * Text returned to the caller. Compact on purpose: indentation alone added ~60% to
 * every response (a page of 23 records went from ~135 KB to 220 KB), and that space
 * comes out of the model's context.
 */
export function serializeResult(result: unknown): string {
  return JSON.stringify(result) ?? "null";
}
