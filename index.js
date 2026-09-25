import 'dotenv/config';
import express from 'express';
import { getCandidates, downloadCandidate } from './src/subtitleFetcher.js';
import { parseSrt, toSrt, translateCues } from './src/translator.js';
import { getCached, setCached } from './src/cache.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 7000;
const QUICK_COUNT = 30; // how many cues to translate immediately before returning
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

const manifest = {
  id: 'org.hebrewlivesubs.addon',
  version: '1.6.1',
  name: 'A-HEBSUB By Ronen.z',
  description: 'לוקח כתוביות אנגלית קיימות ומתרגם אותן לעברית תוך כדי צפייה',
  logo: 'https://em-content.zobj.net/source/microsoft-teams/363/flag-israel_1f1ee-1f1f1.png',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

app.get('/manifest.json', (req, res) => res.json(manifest));

const CANDIDATE_MARK = '__c';

function parseIdParam(rawIdParam) {
  const withoutSuffix = rawIdParam.replace(/\.json$/, '').replace(/\.srt$/, '');
  const markIndex = withoutSuffix.lastIndexOf(CANDIDATE_MARK);

  let idParam = withoutSuffix;
  let candidateIndex = 0;
  if (markIndex !== -1) {
    idParam = withoutSuffix.slice(0, markIndex);
    candidateIndex = parseInt(withoutSuffix.slice(markIndex + CANDIDATE_MARK.length), 10) || 0;
  }

  const [imdbId, season, episode] = idParam.split(':');
  return { idParam, imdbId, season, episode, candidateIndex };
}

// Heuristic: Hebrew text looks nothing like English, so if translation truly
// ran, cue text should have changed for most lines. If most lines are byte-
// for-byte identical to the original, every engine was almost certainly
// down/blocked for this whole batch rather than the text genuinely having
// no translatable content.
function translationLooksReal(beforeTexts, cues) {
  if (!cues.length) return true;
  const changed = cues.filter((c, i) => c.text !== beforeTexts[i]).length;
  return changed / cues.length >= 0.5;
}

// Keeps track of the "quick" build currently in progress per subtitle, so two
// near-simultaneous requests for the same subtitle share the same fast pass
// instead of each independently hitting sources/Google Translate.
const inFlight = new Map();

async function getOrBuildTranslatedSrt(cacheKey, candidate, imdbId, season, episode) {
  const cached = getCached(cacheKey);
  if (cached) return cached;

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const buildPromise = (async () => {
    try {
      console.log(`[${cacheKey}] Downloading candidate (${candidate.source})...`);
      const englishSrt = await downloadCandidate(candidate, imdbId, season, episode);
      if (!englishSrt) {
        console.log(`[${cacheKey}] Candidate download returned nothing`);
        return null;
      }

      const cues = parseSrt(englishSrt);
      const quickCues = cues.slice(0, QUICK_COUNT);
      const restCues = cues.slice(QUICK_COUNT);

      console.log(`[${cacheKey}] Translating first ${quickCues.length} cues (fast pass)...`);
      const beforeQuick = quickCues.map(c => c.text);
      await translateCues(quickCues, 'iw');
      const quickSucceeded = translationLooksReal(beforeQuick, quickCues);

      const partialSrt = toSrt([...quickCues, ...restCues]);

      if (!quickSucceeded) {
        // Every translation engine was down/blocked right now — the text
        // came back unchanged. Don't cache this as if it were final, or
        // every future request for this title would be stuck serving
        // untranslated English forever. Return it for just this request;
        // the next request will start over and try again from scratch.
        console.error(`[${cacheKey}] Translation appears to have failed entirely (engines likely down) — not caching, will retry next request.`);
        return partialSrt;
      }

      // Partial file: start of the movie in Hebrew, the rest still in the
      // original language for now. This is what we return immediately.
      setCached(cacheKey, partialSrt);
      console.log(`[${cacheKey}] Fast pass cached (${quickCues.length}/${cues.length} cues translated).`);

      // Continue translating the rest in the background, without blocking
      // the response. Once done, overwrite the cache with the full version.
      if (restCues.length) {
        const beforeRest = restCues.map(c => c.text);
        translateCues(restCues, 'iw')
          .then(() => {
            if (!translationLooksReal(beforeRest, restCues)) {
              console.error(`[${cacheKey}] Background translation looks like it failed too — leaving the earlier (partial) cache in place instead of overwriting it with untranslated text.`);
              return;
            }
            const fullSrt = toSrt([...quickCues, ...restCues]);
            setCached(cacheKey, fullSrt);
            console.log(`[${cacheKey}] Background translation complete — full file cached.`);
          })
          .catch(err => {
            console.error(`[${cacheKey}] Background translation failed:`, err.message);
          });
      }

      return partialSrt;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, buildPromise);
  return buildPromise;
}

// LIST endpoint: must respond fast. Only searches for candidates (no
// download or translation here) and offers each one as its own row, so the
// person can try another if the first is the wrong language or out of sync.
app.get('/subtitles/:type/:idParam/:extra?', async (req, res) => {
  try {
    const { idParam, imdbId, season, episode } = parseIdParam(req.params.idParam);
    console.log(`[LIST] Request for type=${req.params.type} id=${idParam}${req.params.extra ? ` extra=${req.params.extra}` : ''}`);
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const candidates = await getCandidates(imdbId, season, episode);
    console.log(`[LIST] ${idParam}: found ${candidates.length} candidate(s)`);
    if (!candidates.length) return res.json({ subtitles: [] });

    const subtitles = candidates.map((candidate, i) => ({
      id: `heb-${idParam}-${i}`,
      url: `${baseUrl}/subs/${req.params.type}/${encodeURIComponent(idParam + CANDIDATE_MARK + i)}.srt`,
      lang: 'heb',
    }));

    res.json({ subtitles });
  } catch (err) {
    console.error('Error handling subtitles list request:', err);
    res.json({ subtitles: [] });
  }
});

// FILE endpoint: re-fetches candidates for this title (to know which one the
// requested index refers to), downloads that one, does the fast first-30-cues
// translation synchronously, then keeps translating the rest in the
// background. Re-requesting this URL later returns whatever is cached at
// that point (which will be more complete, up to the full file).
app.get('/subs/:type/:idParam', async (req, res) => {
  try {
    const { idParam, imdbId, season, episode, candidateIndex } = parseIdParam(req.params.idParam);
    const cacheKey = `heb_${idParam}_c${candidateIndex}`;

    if (!getCached(cacheKey) && !inFlight.has(cacheKey)) {
      const candidates = await getCandidates(imdbId, season, episode);
      const candidate = candidates[candidateIndex];
      if (!candidate) return res.status(404).send('Candidate not found');

      const srt = await getOrBuildTranslatedSrt(cacheKey, candidate, imdbId, season, episode);
      if (!srt) return res.status(404).send('No subtitle available');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(srt);
    }

    // Already cached or already building — just await/return it (candidate
    // details aren't needed again once the build is in flight or done).
    const cachedOrPending = getCached(cacheKey) || (await inFlight.get(cacheKey));
    if (!cachedOrPending) return res.status(404).send('No subtitle available');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(cachedOrPending);
  } catch (err) {
    console.error('Error handling subtitle file request:', err);
    res.status(500).send('Error generating subtitle');
  }
});

app.get('/', (req, res) => {
  res.send('Hebrew Live Subs addon is running. Install via /manifest.json');
});

// Manual cache wipe, for when a stale/failed translation got cached and you
// don't want to wait for the next redeploy (which also clears it). No auth —
// fine for a personal addon whose URL isn't public, but don't share this URL.
app.get('/admin/clear-cache', (req, res) => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const cacheDir = path.join(__dirname, 'cache');
  let cleared = 0;
  try {
    for (const file of fs.readdirSync(cacheDir)) {
      if (file.endsWith('.srt')) {
        fs.unlinkSync(path.join(cacheDir, file));
        cleared++;
      }
    }
    res.send(`Cleared ${cleared} cached subtitle file(s).`);
  } catch (err) {
    res.status(500).send(`Error clearing cache: ${err.message}`);
  }
});

// Safety net: logs any request that didn't match a route above, so we can
// spot unexpected URL shapes Stremio (or a player) might be sending.
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Addon server running on port ${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
});
