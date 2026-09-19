import AdmZip from 'adm-zip';

const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const SUBDL_BASE = 'https://api.subdl.com/api/v1/subtitles';

function osHeaders() {
  return {
    'Api-Key': process.env.OS_API_KEY,
    'User-Agent': 'hebrew-live-subs v1.0.0',
    'Content-Type': 'application/json',
  };
}

// ---------- OpenSubtitles (primary source) ----------

async function searchBestOnOpenSubtitles(imdbId, season, episode) {
  const params = new URLSearchParams({
    imdb_id: imdbId.replace('tt', ''),
    languages: 'en',
    order_by: 'download_count',
    order_direction: 'desc',
  });
  if (season) params.set('season_number', season);
  if (episode) params.set('episode_number', episode);

  const searchRes = await fetch(`${OS_BASE}/subtitles?${params}`, { headers: osHeaders() });
  if (!searchRes.ok) {
    throw new Error(`OpenSubtitles search failed: ${searchRes.status} ${await searchRes.text()}`);
  }
  const searchData = await searchRes.json();
  return searchData.data?.[0] || null;
}

async function hasOnOpenSubtitles(imdbId, season, episode) {
  try {
    const best = await searchBestOnOpenSubtitles(imdbId, season, episode);
    return !!best?.attributes?.files?.[0]?.file_id;
  } catch (err) {
    console.error('OpenSubtitles existence check failed:', err.message);
    return false;
  }
}

async function downloadFromOpenSubtitles(imdbId, season, episode) {
  const best = await searchBestOnOpenSubtitles(imdbId, season, episode);
  if (!best) return null;

  const fileId = best.attributes.files?.[0]?.file_id;
  if (!fileId) return null;

  const downloadRes = await fetch(`${OS_BASE}/download`, {
    method: 'POST',
    headers: osHeaders(),
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!downloadRes.ok) {
    throw new Error(`OpenSubtitles download failed: ${downloadRes.status} ${await downloadRes.text()}`);
  }
  const downloadData = await downloadRes.json();

  const fileRes = await fetch(downloadData.link);
  if (!fileRes.ok) throw new Error('Failed to fetch subtitle file body from OpenSubtitles');
  return await fileRes.text();
}

// ---------- SubDL (fallback source) ----------
// Free API, requires a free API key from subdl.com/panel/api. Subtitles are
// served as .zip files, so we need to extract the .srt from inside.

function subdlEnabled() {
  return !!process.env.SUBDL_API_KEY;
}

async function searchBestOnSubDL(imdbId, season, episode) {
  const params = new URLSearchParams({
    api_key: process.env.SUBDL_API_KEY,
    imdb_id: imdbId,
    languages: 'EN',
    type: season ? 'tv' : 'movie',
  });
  if (season) params.set('season_number', season);
  if (episode) params.set('episode_number', episode);

  const res = await fetch(`${SUBDL_BASE}?${params}`);
  if (!res.ok) {
    throw new Error(`SubDL search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.subtitles?.[0] || null;
}

async function hasOnSubDL(imdbId, season, episode) {
  if (!subdlEnabled()) return false;
  try {
    const best = await searchBestOnSubDL(imdbId, season, episode);
    return !!best?.url;
  } catch (err) {
    console.error('SubDL existence check failed:', err.message);
    return false;
  }
}

async function downloadFromSubDL(imdbId, season, episode) {
  if (!subdlEnabled()) return null;
  const best = await searchBestOnSubDL(imdbId, season, episode);
  if (!best?.url) return null;

  // best.url is a relative path; SubDL serves the actual file from dl.subdl.com
  const zipUrl = best.url.startsWith('http') ? best.url : `https://dl.subdl.com${best.url}`;
  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) throw new Error(`Failed to download SubDL zip: ${zipRes.status}`);

  const buffer = Buffer.from(await zipRes.arrayBuffer());
  const zip = new AdmZip(buffer);
  const srtEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.srt'));
  if (!srtEntry) throw new Error('No .srt file found inside SubDL zip');

  return srtEntry.getData().toString('utf-8');
}

// ---------- Public API: tries OpenSubtitles first, falls back to SubDL ----------

/**
 * Fast check (search only, no download) used to decide whether to even
 * offer a Hebrew subtitle option in the subtitles list.
 */
export async function hasEnglishSubtitle(imdbId, season, episode) {
  if (await hasOnOpenSubtitles(imdbId, season, episode)) return true;
  return hasOnSubDL(imdbId, season, episode);
}

/**
 * Searches OpenSubtitles first; if that fails or finds nothing, falls back
 * to SubDL. Returns the raw .srt text, or null if neither source has it.
 */
export async function fetchEnglishSrt(imdbId, season, episode) {
  try {
    const fromOS = await downloadFromOpenSubtitles(imdbId, season, episode);
    if (fromOS) return fromOS;
  } catch (err) {
    console.error('OpenSubtitles fetch failed, trying SubDL fallback:', err.message);
  }

  if (subdlEnabled()) {
    try {
      const fromSubDL = await downloadFromSubDL(imdbId, season, episode);
      if (fromSubDL) return fromSubDL;
    } catch (err) {
      console.error('SubDL fallback also failed:', err.message);
    }
  }

  return null;
}
