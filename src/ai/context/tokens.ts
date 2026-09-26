/**
 * PharmaTRACK AI Engine — token estimation and safe truncation.
 *
 * No tokeniser is bundled: shipping a BPE table for every model family would
 * add hundreds of KB to an offline app, and the goal here is *budgeting*, not
 * exact billing. A deliberately pessimistic characters-per-token ratio means we
 * over-estimate slightly, which is the safe direction — the failure mode we are
 * preventing is "context too large" from the provider.
 */

/** Conservative average for English academic prose (real BPE is ~4.0–4.2). */
const CHARS_PER_TOKEN = 3.6;

/** Rough token count for a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Inverse of `estimateTokens`, used when trimming to a budget. */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/**
 * Trims `text` to roughly `maxTokens`, cutting on a paragraph → sentence →
 * word boundary so the truncated context still reads sensibly.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = tokensToChars(maxTokens);
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const cut = Math.max(
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
  );
  if (cut > maxChars * 0.5) return slice.slice(0, cut + 1).trimEnd();
  const space = slice.lastIndexOf(' ');
  return (space > maxChars * 0.8 ? slice.slice(0, space) : slice).trimEnd();
}

/** Formats a token count for the UI ("~1.2k tokens"). */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `~${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens`;
  return `~${tokens} tokens`;
}
