import { translate } from '@vitalets/google-translate-api';
import SrtParser2 from 'srt-parser-2';

const parser = new SrtParser2();

// Google's unofficial free endpoint has a practical limit per request.
// We batch multiple subtitle lines together (joined by a unique separator)
// to drastically cut down the number of requests, then split the result
// back apart. This keeps translation of a full movie to a handful of calls.
const BATCH_CHAR_LIMIT = 4000;
const SEPARATOR = '\n@@|@@\n';
const CONCURRENCY = 4;

function chunkCues(cues) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const cue of cues) {
    const len = cue.text.length + SEPARATOR.length;
    if (currentLen + len > BATCH_CHAR_LIMIT && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(cue);
    currentLen += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function translateChunk(cues, targetLang) {
  const joined = cues.map(c => c.text.replace(/\r?\n/g, ' ')).join(SEPARATOR);
  const { text } = await translate(joined, { to: targetLang });
  const parts = text.split(SEPARATOR.trim());

  // Fallback: if the separator got mangled by translation, split by line count
  if (parts.length !== cues.length) {
    const fallbackParts = text.split(/\n+/).filter(Boolean);
    return cues.map((c, i) => fallbackParts[i] || c.text);
  }
  return parts.map(p => p.trim());
}

async function translateAllChunks(chunks, targetLang) {
  const results = new Array(chunks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < chunks.length) {
      const i = nextIndex++;
      results[i] = await translateChunk(chunks[i], targetLang);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker);
  await Promise.all(workers);
  return results;
}

export function parseSrt(srtContent) {
  return parser.fromSrt(srtContent);
}

export function toSrt(cues) {
  return parser.toSrt(cues);
}

/**
 * Translates an array of srt-parser-2 cue objects IN PLACE (mutates .text),
 * and also returns them. Handles chunking + parallel requests internally,
 * so it's safe to call with anywhere from a handful of cues to a whole movie.
 */
export async function translateCues(cues, targetLang = 'iw') {
  if (!cues.length) return cues;
  const chunks = chunkCues(cues);
  const translatedChunks = await translateAllChunks(chunks, targetLang);

  let cursor = 0;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const translatedTexts = translatedChunks[c];
    for (let i = 0; i < chunk.length; i++) {
      cues[cursor + i].text = translatedTexts[i] ?? chunk[i].text;
    }
    cursor += chunk.length;
  }
  return cues;
}

/**
 * Translates a full SRT file's text content to targetLang (e.g. 'iw' for Hebrew),
 * preserving all timing/index information. Convenience wrapper around
 * parseSrt + translateCues + toSrt for simple one-shot use.
 */
export async function translateSrt(srtContent, targetLang = 'iw') {
  const cues = parseSrt(srtContent);
  await translateCues(cues, targetLang);
  return toSrt(cues);
}
