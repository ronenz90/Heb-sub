const OS_BASE = 'https://api.opensubtitles.com/api/v1';

function headers() {
  return {
    'Api-Key': process.env.OS_API_KEY,
    'User-Agent': 'hebrew-live-subs v1.0.0',
    'Content-Type': 'application/json',
  };
}

/**
 * Searches OpenSubtitles for the best-matching English subtitle
 * for a movie (imdbId) or an episode (imdbId + season + episode).
 * Returns the raw .srt text, or null if none found.
 */
export async function fetchEnglishSrt(imdbId, season, episode) {
  const params = new URLSearchParams({
    imdb_id: imdbId.replace('tt', ''),
    languages: 'en',
    order_by: 'download_count',
    order_direction: 'desc',
  });
  if (season) params.set('season_number', season);
  if (episode) params.set('episode_number', episode);

  const searchRes = await fetch(`${OS_BASE}/subtitles?${params}`, { headers: headers() });
  if (!searchRes.ok) {
    throw new Error(`OpenSubtitles search failed: ${searchRes.status} ${await searchRes.text()}`);
  }
  const searchData = await searchRes.json();
  const best = searchData.data?.[0];
  if (!best) return null;

  const fileId = best.attributes.files?.[0]?.file_id;
  if (!fileId) return null;

  const downloadRes = await fetch(`${OS_BASE}/download`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!downloadRes.ok) {
    throw new Error(`OpenSubtitles download failed: ${downloadRes.status} ${await downloadRes.text()}`);
  }
  const downloadData = await downloadRes.json();

  const fileRes = await fetch(downloadData.link);
  if (!fileRes.ok) throw new Error('Failed to fetch subtitle file body');
  return await fileRes.text();
}
