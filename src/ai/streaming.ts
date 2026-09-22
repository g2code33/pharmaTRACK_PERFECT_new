/**
 * PharmaTRACK AI Engine — streaming helpers.
 *
 * Every adapter produces the same thing from wildly different wire formats:
 * an async iterator of `AIStreamDelta`. OpenAI-style SSE, Anthropic's event
 * stream and Gemini's `:streamGenerateContent` all end up here.
 */
import type { AIStreamDelta, AIUsage } from './types';

/** Parsed server-sent event: the `event:` name plus the decoded JSON payload. */
export interface SseEvent {
  event?: string;
  data: unknown;
  raw: string;
}

/**
 * Minimal SSE parser. Yields on blank lines (the spec's event boundary) and
 * tolerates the common vendor deviations: `data:` without a space, CRLF line
 * endings, multi-line `data:` payloads mixed with plain JSON lines, and a
 * trailing event with no newline.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (!dataLines.length && name === undefined) return null;
    const raw = dataLines.join('\n');
    const event: SseEvent = { event: name, data: decodeJson(raw), raw };
    name = undefined;
    dataLines = [];
    return event;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);

        if (line === '') {
          const event = flush();
          if (event) yield event;
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keep-alive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const rest = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') name = rest;
        else if (field === 'data') dataLines.push(rest);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const line = buffer.replace(/\r$/, '');
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const rest = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') dataLines.push(rest);
      else if (field === 'event') name = rest;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock?.();
  }
}

function decodeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === '[DONE]') return '[DONE]';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed; // some gateways stream bare text chunks
  }
}

/** Reads an OpenAI `usage` block (also used by Groq/NVIDIA/OpenRouter/Mistral). */
export function usageFrom(body: unknown): AIUsage | undefined {
  const usage = (body as { usage?: Record<string, number | undefined> })?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (input === undefined && output === undefined) return undefined;
  return { inputTokens: input, outputTokens: output };
}

/** Convenience for adapters that only need to yield plain text. */
export async function* deltasFrom(
  source: AsyncGenerator<{ text?: string; usage?: AIUsage }, void, unknown>,
): AsyncGenerator<AIStreamDelta> {
  for await (const chunk of source) {
    if (chunk.text || chunk.usage) yield { text: chunk.text ?? '', usage: chunk.usage };
  }
}
