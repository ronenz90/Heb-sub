import AdmZip from 'adm-zip';

const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const SUBDL_BASE = 'https://api.subdl.com/api/v1/subtitles';
const MAX_CANDIDATES = 4;

function osHeaders() {
  return {
    'Api-Key': process.env.OS_API_KEY,
    'User-Agent': 'hebrew-live-subs v1.0.0',
    'Content-Type': 'application/json',
  };
}

function subdlEnabled() {
  return !!process.env.SUBDL_API_KEY;
}

// ---------- OpenSubtitles (primary source) ----------

async function searchOpenSubtitles(imdbId, season, episode) {
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
  return searchData.data || [];
}

async function downloadFromOpenSubtitles(fileId) {
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

async function downloadFromSubDL(url) {
  const zipUrl = url.startsWith('http') ? url : `https://dl.subdl.com${url}`;
  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) throw new Error(`Failed to download SubDL zip: ${zipRes.status}`);

  const buffer = Buffer.from(await zipRes.arrayBuffer());
  const zip = new AdmZip(buffer);
  const srtEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.srt'));
  if (!srtEntry) throw new Error('No .srt file found inside SubDL zip');

  return srtEntry.getData().toString('utf-8');
}

// ---------- Public API ----------

/**
 * Returns up to MAX_CANDIDATES distinct English-subtitle candidates for this
 * title (mostly from OpenSubtitles, topped up with a SubDL result if there's
 * room), WITHOUT downloading any of them yet. Each candidate is a small
 * descriptor {source, fileId|url} that downloadCandidate() can resolve later.
 * Offering several candidates lets the person try another one if the first
 * turns out to be the wrong language or badly out of sync.
 */
export async function getCandidates(imdbId, season, episode) {
  const candidates = [];

  try {
    const results = await searchOpenSubtitles(imdbId, season, episode);
    for (const r of results) {
      const fileId = r.attributes?.files?.[0]?.file_id;
      if (fileId) candidates.push({ source: 'opensubtitles', fileId });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
  } catch (err) {
    console.error('OpenSubtitles search failed:', err.message);
  }

  if (candidates.length < MAX_CANDIDATES && subdlEnabled()) {
    try {
      const best = await searchBestOnSubDL(imdbId, season, episode);
      if (best?.url) candidates.push({ source: 'subdl', url: best.url });
    } catch (err) {
      console.error('SubDL search failed:', err.message);
    }
  }

  return candidates;
}

/** Downloads the actual .srt text for one candidate returned by getCandidates(). */
export async function downloadCandidate(candidate) {
  if (candidate.source === 'opensubtitles') return downloadFromOpenSubtitles(candidate.fileId);
  if (candidate.source === 'subdl') return downloadFromSubDL(candidate.url);
  return null;
}
