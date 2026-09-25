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

const CONSECUTIVE_FAILURE_LIMIT = 3;
const NETWORK_FAILURE_COOLDOWN_MS = 5 * 60_000; // 5 minutes — a network-level block (e.g. the mirror blocking cloud IPs) won't clear itself in a minute

function makeEngine({ name, paceMs, translateOne }) {
  let blockedUntil = 0;
  let consecutiveFailures = 0;

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
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures++;
          const rateLimited = isRateLimitError(err);
          const tooManyFailures = consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT;

          if (rateLimited || tooManyFailures) {
            const cooldown = rateLimited ? COOLDOWN_MS : NETWORK_FAILURE_COOLDOWN_MS;
            console.error(
              rateLimited
                ? `${name} rate-limited us — cooling down for ${cooldown / 1000}s.`
                : `${name} failed ${consecutiveFailures} times in a row (${err.message}) — assuming it's down, cooling down for ${cooldown / 1000}s.`
            );
            blockedUntil = Date.now() + cooldown;
            consecutiveFailures = 0;
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

const LIBRETRANSLATE_MIRRORS = [
  'https://translate.argosopentech.com/translate',
  'https://libretranslate.de/translate',
  'https://translate.mentality.rip/translate',
];

const libreTranslate = makeEngine({
  name: 'LibreTranslate',
  paceMs: 1500,
  translateOne: async (text, targetLang) => {
    const lang = targetLang === 'iw' ? 'he' : targetLang;
    // Community-run free mirrors (no API key). Any one of them can be down
    // or slow at a given moment since they're volunteer-run, so we try a
    // few in turn before giving up on this engine for this line.
    let lastErr;
    for (const mirror of LIBRETRANSLATE_MIRRORS) {
      try {
        const res = await fetch(mirror, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: text, source: 'en', target: lang, format: 'text' }),
        });
        if (!res.ok) throw new Error(`${mirror} returned ${res.status}`);
        const data = await res.json();
        if (!data.translatedText) throw new Error(`${mirror} returned no translation`);
        return data.translatedText;
      } catch (err) {
        lastErr = err;
        // try the next mirror
      }
    }
    throw lastErr || new Error('All LibreTranslate mirrors failed');
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

// --- Gemma (top priority when configured) --------------------------------
// Your own hosted model. It's an LLM, not a dedicated translation API, so we
// ask it to translate a batch of separator-joined lines and return them in
// the same order/format — same trick as Google, but LLM output is less
// strictly guaranteed to match, so we validate the count before trusting it
// and fall through if it doesn't line up. Also gets a long timeout since
// your Render instance can be asleep and take a while to wake up.

const GEMMA_URL = 'https://gemma-i7on.onrender.com/generate';
const GEMMA_TIMEOUT_MS = 120_000; // LLM cold start (server wake + model load into memory) can take well over a minute
const GEMMA_SUB_BATCH_SIZE = 12; // small batches so the model doesn't run out of output tokens mid-response
const GEMMA_MAX_TOKENS = 4000;  // generous headroom — Hebrew output tends to use more tokens than the English input

let gemmaBlockedUntil = 0;
let gemmaConsecutiveFailures = 0;

function gemmaEnabled() {
  return !!process.env.GEMMA_API_KEY;
}

async function translateSubBatchViaGemma(cues, targetLang) {
  const langName = targetLang === 'iw' || targetLang === 'he' ? 'Hebrew' : targetLang;
  const sep = SEPARATOR.trim();
  const joined = cues.map(c => c.text.replace(/\r?\n/g, ' ')).join(SEPARATOR);
  const prompt =
    `Translate each of the following ${cues.length} subtitle lines to ${langName}. ` +
    `The lines are separated by the exact token "${sep}". ` +
    `Return ONLY the translations, in the exact same order, separated by that exact same token "${sep}". ` +
    `Do not add numbering, quotes, explanations, or anything else — output only the translated lines and separators.\n\n${joined}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${GEMMA_URL}?api_key=${encodeURIComponent(process.env.GEMMA_API_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        max_tokens: GEMMA_MAX_TOKENS,
        temperature: 0.3,
        system: 'You are a precise subtitle translator. Follow the formatting instructions exactly and output nothing else.',
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const err = new Error(`Gemma failed: ${res.status} ${await res.text()}`);
      err.isRateLimit = res.status === 429;
      throw err;
    }

    const data = await res.json();
    const text = data.response;
    if (!text) throw new Error('Gemma returned no response text');

    const parts = text.split(sep);
    if (parts.length === cues.length) return parts.map(p => p.trim());

    const fallbackParts = text.split(/\n+/).filter(Boolean);
    if (fallbackParts.length === cues.length) return fallbackParts.map(p => p.trim());

    throw new Error(`Gemma returned ${parts.length} parts, expected ${cues.length} — output likely truncated or malformed`);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function translateChunkViaGemma(cues, targetLang) {
  try {
    const results = [];
    for (let i = 0; i < cues.length; i += GEMMA_SUB_BATCH_SIZE) {
      const subBatch = cues.slice(i, i + GEMMA_SUB_BATCH_SIZE);
      const translated = await translateSubBatchViaGemma(subBatch, targetLang);
      results.push(...translated);
    }
    gemmaConsecutiveFailures = 0;
    return results;
  } catch (err) {
    gemmaConsecutiveFailures++;
    const rateLimited = err.isRateLimit;
    const tooManyFailures = gemmaConsecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT;

    if (rateLimited || tooManyFailures) {
      const cooldown = rateLimited ? COOLDOWN_MS : NETWORK_FAILURE_COOLDOWN_MS;
      console.error(`Gemma unavailable (${err.message}) — cooling down for ${cooldown / 1000}s.`);
      gemmaBlockedUntil = Date.now() + cooldown;
      gemmaConsecutiveFailures = 0;
    } else {
      console.error('Gemma failed for this chunk:', err.message);
    }
    return null; // signal "try the next engine" (whole chunk falls through — no mixed partial results)
  }
}

// --- Google (secondary) ---------------------------------------------------

let googleBlockedUntil = 0;
let googleConsecutiveFailures = 0;

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

async function translateChunkViaGoogle(cues, targetLang) {
  const joined = cues.map(c => c.text.replace(/\r?\n/g, ' ')).join(SEPARATOR);

  if (Date.now() >= googleBlockedUntil) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { text } = await translate(joined, { to: targetLang });
        await sleep(500); // pace even successful calls
        googleConsecutiveFailures = 0;
        const parts = text.split(SEPARATOR.trim());

        if (parts.length !== cues.length) {
          const fallbackParts = text.split(/\n+/).filter(Boolean);
          return cues.map((c, i) => fallbackParts[i] || c.text);
        }
        return parts.map(p => p.trim());
      } catch (err) {
        if (!isRateLimitError(err)) {
          googleConsecutiveFailures++;
          if (googleConsecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
            console.error(`Google failed ${googleConsecutiveFailures} times in a row (${err.message}) — assuming it's unreachable, cooling down for 5min.`);
            googleBlockedUntil = Date.now() + NETWORK_FAILURE_COOLDOWN_MS;
            googleConsecutiveFailures = 0;
          }
          break;
        }
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

async function translateChunk(cues, targetLang) {
  if (gemmaEnabled()) {
    if (Date.now() >= gemmaBlockedUntil) {
      const result = await translateChunkViaGemma(cues, targetLang);
      if (result) return result;
      // null means Gemma failed/cooled down this round — fall through to Google.
    } else {
      console.log('Gemma still in cooldown, skipping to Google.');
    }
  }
  return translateChunkViaGoogle(cues, targetLang);
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
