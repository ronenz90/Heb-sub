import 'dotenv/config';
import express from 'express';
import { fetchEnglishSrt } from './src/subtitleFetcher.js';
import { translateSrt } from './src/translator.js';
import { getCached, setCached } from './src/cache.js';

const PORT = process.env.PORT || 7000;
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

const manifest = {
  id: 'org.hebrewlivesubs.addon',
  version: '1.0.0',
  name: 'תרגום עברית חי (Live Hebrew Subs)',
  description: 'לוקח כתוביות אנגלית קיימות ומתרגם אותן לעברית תוך כדי צפייה',
  logo: 'https://em-content.zobj.net/source/microsoft-teams/363/flag-israel_1f1ee-1f1f1.png',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

app.get('/manifest.json', (req, res) => res.json(manifest));

// id looks like "tt1234567" (movie) or "tt1234567:1:2" (series: season:episode)
app.get('/subtitles/:type/:idParam', async (req, res) => {
  try {
    const idParam = req.params.idParam.replace(/\.json$/, '');
    const [imdbId, season, episode] = idParam.split(':');
    const cacheKey = `heb_${idParam}`;

    let translatedSrt = getCached(cacheKey);

    if (!translatedSrt) {
      console.log(`[${idParam}] No cache — fetching English subtitle...`);
      const englishSrt = await fetchEnglishSrt(imdbId, season, episode);
      if (!englishSrt) {
        console.log(`[${idParam}] No English subtitle found on OpenSubtitles`);
        return res.json({ subtitles: [] });
      }
      console.log(`[${idParam}] Translating to Hebrew (this can take a bit the first time)...`);
      translatedSrt = await translateSrt(englishSrt, 'iw');
      setCached(cacheKey, translatedSrt);
      console.log(`[${idParam}] Done, cached.`);
    } else {
      console.log(`[${idParam}] Served from cache.`);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      subtitles: [
        {
          id: `heb-${idParam}`,
          url: `${baseUrl}/subs/${encodeURIComponent(cacheKey)}.srt`,
          lang: 'heb',
        },
      ],
    });
  } catch (err) {
    console.error('Error handling subtitles request:', err);
    res.json({ subtitles: [] });
  }
});

app.get('/subs/:key.srt', (req, res) => {
  const content = getCached(req.params.key);
  if (!content) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(content);
});

app.get('/', (req, res) => {
  res.send('Hebrew Live Subs addon is running. Install via /manifest.json');
});

app.listen(PORT, () => {
  console.log(`Addon server running at http://127.0.0.1:${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
});
