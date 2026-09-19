import { translate } from '@vitalets/google-translate-api';
import SrtParser2 from 'srt-parser-2';

const parser = new SrtParser2();

// Google's unofficial free endpoint has a practical limit per request.
// We batch multiple subtitle lines together (joined by a unique separator)
// to drastically cut down the number of requests, then split the result
// back apart. This keeps translation of a full movie to a handful of calls.
const BATCH_CHAR_LIMIT = 4000;
const SEPARATOR = '\n@@|@@\n';
const CONCURRENCY = 1; // fully serial — gentlest possible on the unofficial endpoint
const MAX_RETRIES = 2;
const COOLDOWN_MS = 60_000; // 1 minute, shared shape for every engine's circuit breaker

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  return /Too Many Requests|429/i.test(err?.message || '');
}

// --- Generic per-cue fallback engine runner ------------------------------
// Both MyMemory and LibreTranslate's free public mirrors only accept one
// short text per request (no batching), have small/unclear quotas, and are
// run by volunteers — so every engine here gets its own pacing delay and its
// own circuit breaker (a cooldown window once it rate-limits us), and each
// is tried only when the one before it is unavailable or fails.

function makeEngine({ name, paceMs, translateOne }) {
  let blockedUntil = 0;
  return {
    name,
    async translateChunk(cues, targetLang) {
      if (Date.now() < blockedUntil) {
        console.log(`${name} still in cooldown, skipping.`);
        return null; // signal "try the next engine"
      }
      const results = [];
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        try {
          const text = await translateOne(cue.text.replace(/\r?\n/g, ' '), targetLang);
          results.push(text);
        } catch (err) {
          if (isRateLimitError(err)) {
            console.error(`${name} rate-limited us — cooling down for 60s.`);
            blockedUntil = Date.now() + COOLDOWN_MS;
            // Fill remaining lines with originals and bail on this engine.
            results.push(...cues.slice(i).map(c => c.text));
            return results;
          }
          console.error(`${name} failed for a line:`, err.message);
          results.push(cue.text);
        }
        await sleep(paceMs);
      }
      return results;
    },
  };
}

const myMemory = makeEngine({
  name: 'MyMemory',
  paceMs: 1200,
  translateOne: async (text, targetLang) => {
    const lang = targetLang === 'iw' ? 'he' : targetLang;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${lang}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MyMemory failed: ${res.status}`);
    const data = await res.json();
    const translated = data.responseData?.translatedText;
    if (!translated) throw new Error('MyMemory returned no translation');
    return translated;
  },
});

const libreTranslate = makeEngine({
  name: 'LibreTranslate',
  paceMs: 1500,
  translateOne: async (text, targetLang) => {
    const lang = targetLang === 'iw' ? 'he' : targetLang;
    // Community-run free mirror (no API key). Can be slower/less reliable
    // than the official paid libretranslate.com, but costs nothing.
    const res = await fetch('https://translate.argosopentech.com/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'en', target: lang, format: 'text' }),
    });
    if (!res.ok) throw new Error(`LibreTranslate failed: ${res.status}`);
    const data = await res.json();
    if (!data.translatedText) throw new Error('LibreTranslate returned no translation');
    return data.translatedText;
  },
});

const FALLBACK_ENGINES = [myMemory, libreTranslate];

async function translateChunkViaFallbacks(cues, targetLang) {
  for (const engine of FALLBACK_ENGINES) {
    const result = await engine.translateChunk(cues, targetLang);
    if (result) return result;
  }
  // Every fallback is either down or in cooldown — give up gracefully.
  return cues.map(c => c.text);
}

// --- Google (primary) ----------------------------------------------------

let googleBlockedUntil = 0;

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

  if (Date.now() >= googleBlockedUntil) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { text } = await translate(joined, { to: targetLang });
        await sleep(500); // pace even successful calls
        const parts = text.split(SEPARATOR.trim());

        if (parts.length !== cues.length) {
          const fallbackParts = text.split(/\n+/).filter(Boolean);
          return cues.map((c, i) => fallbackParts[i] || c.text);
        }
        return parts.map(p => p.trim());
      } catch (err) {
        if (!isRateLimitError(err)) break;
        if (attempt === MAX_RETRIES) {
          console.error('Google rate-limited us repeatedly — cooling down for 60s.');
          googleBlockedUntil = Date.now() + COOLDOWN_MS;
          break;
        }
        const waitMs = 1500 * Math.pow(2, attempt); // 1.5s, 3s
        console.log(`Rate limited by Google, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(waitMs);
      }
    }
  } else {
    console.log('Google still in cooldown, skipping straight to fallbacks.');
  }

  return translateChunkViaFallbacks(cues, targetLang);
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
