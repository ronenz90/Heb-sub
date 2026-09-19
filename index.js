import 'dotenv/config';
import express from 'express';
import { fetchEnglishSrt, hasEnglishSubtitle } from './src/subtitleFetcher.js';
import { parseSrt, toSrt, translateCues } from './src/translator.js';
import { getCached, setCached } from './src/cache.js';

const PORT = process.env.PORT || 7000;
const QUICK_COUNT = 30; // how many cues to translate immediately before returning
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

const manifest = {
  id: 'org.hebrewlivesubs.addon',
  version: '1.2.0',
  name: 'תרגום עברית חי (Live Hebrew Subs)',
  description: 'לוקח כתוביות אנגלית קיימות ומתרגם אותן לעברית תוך כדי צפייה',
  logo: 'https://em-content.zobj.net/source/microsoft-teams/363/flag-israel_1f1ee-1f1f1.png',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

app.get('/manifest.json', (req, res) => res.json(manifest));

function parseIdParam(rawIdParam) {
  const idParam = rawIdParam.replace(/\.json$/, '');
  const [imdbId, season, episode] = idParam.split(':');
  return { idParam, imdbId, season, episode };
}

// Keeps track of the "quick" build currently in progress per subtitle, so two
// near-simultaneous requests for the same subtitle share the same fast pass
// instead of each independently hitting OpenSubtitles/Google Translate.
const inFlight = new Map();

async function getOrBuildTranslatedSrt(cacheKey, imdbId, season, episode) {
  const cached = getCached(cacheKey);
  if (cached) return cached;

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const buildPromise = (async () => {
    try {
      console.log(`[${cacheKey}] Fetching English subtitle...`);
      const englishSrt = await fetchEnglishSrt(imdbId, season, episode);
      if (!englishSrt) {
        console.log(`[${cacheKey}] No English subtitle found`);
        return null;
      }

      const cues = parseSrt(englishSrt);
      const quickCues = cues.slice(0, QUICK_COUNT);
      const restCues = cues.slice(QUICK_COUNT);

      console.log(`[${cacheKey}] Translating first ${quickCues.length} cues (fast pass)...`);
      await translateCues(quickCues, 'iw');

      // Partial file: start of the movie in Hebrew, the rest still in English
      // for now. This is what we return immediately.
      const partialSrt = toSrt([...quickCues, ...restCues]);
      setCached(cacheKey, partialSrt);
      console.log(`[${cacheKey}] Fast pass cached (${quickCues.length}/${cues.length} cues translated).`);

      // Continue translating the rest in the background, without blocking
      // the response. Once done, overwrite the cache with the full version.
      if (restCues.length) {
        translateCues(restCues, 'iw')
          .then(() => {
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

// LIST endpoint: must respond fast. Only does a quick existence check
// (single search call) — never downloads or translates here.
app.get('/subtitles/:type/:idParam/:extra?', async (req, res) => {
  try {
    const { idParam, imdbId, season, episode } = parseIdParam(req.params.idParam);
    console.log(`[LIST] Request for type=${req.params.type} id=${idParam}${req.params.extra ? ` extra=${req.params.extra}` : ''}`);
    const cacheKey = `heb_${idParam}`;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const subtitleEntry = {
      id: `heb-${idParam}`,
      url: `${baseUrl}/subs/${req.params.type}/${encodeURIComponent(idParam)}.srt`,
      lang: 'heb',
    };

    // If we already have something cached (partial or full), we know for
    // certain a subtitle exists — no need for an extra search call.
    if (getCached(cacheKey)) {
      return res.json({ subtitles: [subtitleEntry] });
    }

    const exists = await hasEnglishSubtitle(imdbId, season, episode);
    console.log(`[LIST] ${idParam}: English subtitle exists = ${exists}`);
    if (!exists) return res.json({ subtitles: [] });

    res.json({ subtitles: [subtitleEntry] });
  } catch (err) {
    console.error('Error handling subtitles list request:', err);
    res.json({ subtitles: [] });
  }
});

// FILE endpoint: fetches English subtitle + does the fast first-30-cues
// translation synchronously, then keeps translating the rest in the
// background. Re-requesting this URL later returns whatever is cached at
// that point (which will be more complete, up to the full file).
app.get('/subs/:type/:idParam', async (req, res) => {
  try {
    const { idParam, imdbId, season, episode } = parseIdParam(
      req.params.idParam.replace(/\.srt$/, '')
    );
    const cacheKey = `heb_${idParam}`;

    const srt = await getOrBuildTranslatedSrt(cacheKey, imdbId, season, episode);
    if (!srt) return res.status(404).send('No subtitle available');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(srt);
  } catch (err) {
    console.error('Error handling subtitle file request:', err);
    res.status(500).send('Error generating subtitle');
  }
});

app.get('/', (req, res) => {
  res.send('Hebrew Live Subs addon is running. Install via /manifest.json');
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
