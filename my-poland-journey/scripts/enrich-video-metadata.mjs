// One-off / re-runnable enrichment script.
// Fills in title, author (channel name), and runtime for every video item in
// content.json by calling the YouTube Data API v3 videos.list endpoint.
//
// Usage:
//   cd my-poland-journey
//   node scripts/enrich-video-metadata.mjs [--force] [--description]
//
//   --force        overwrite items that already have a title (default: skip them)
//   --description  also populate a "description" field on video items
//
// Requires YOUTUBE_API_KEY in my-poland-journey/.env (not committed to git).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = path.join(__dirname, '..', 'data', 'content.json');
const ENV_PATH = path.join(__dirname, '..', '.env');

const FORCE = process.argv.includes('--force');
const INCLUDE_DESCRIPTION = process.argv.includes('--description');

// --- tiny .env loader (no dependency needed) ---
async function loadEnv(envPath) {
  let text;
  try {
    text = await readFile(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Parses ISO 8601 durations like "PT1H2M3S" / "PT12M34S" / "PT45S" into "H:MM:SS" or "MM:SS".
function parseDuration(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!match) return '';
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchVideoBatch(ids, apiKey) {
  const parts = INCLUDE_DESCRIPTION ? 'snippet,contentDetails' : 'snippet,contentDetails';
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', parts);
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${body}`);
  }
  const json = await res.json();
  return json.items || [];
}

async function main() {
  await loadEnv(ENV_PATH);
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error(`Missing YOUTUBE_API_KEY. Add it to ${ENV_PATH}`);
    process.exit(1);
  }

  const raw = await readFile(CONTENT_PATH, 'utf8');
  const content = JSON.parse(raw);

  const videoItems = content.filter((item) => item.form === 'video' && item.youtube_id);
  const targets = FORCE ? videoItems : videoItems.filter((item) => !item.title);

  console.log(`Total video items: ${videoItems.length}`);
  console.log(`Items to enrich: ${targets.length}${FORCE ? ' (--force: overwriting existing titles)' : ' (skipping items that already have a title)'}`);

  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const uniqueIds = [...new Set(targets.map((item) => item.youtube_id))];
  const batches = chunk(uniqueIds, 50); // videos.list allows up to 50 IDs per call

  const infoById = new Map();
  let quotaUnitsUsed = 0;

  for (const [i, batch] of batches.entries()) {
    console.log(`Fetching batch ${i + 1}/${batches.length} (${batch.length} IDs)...`);
    const items = await fetchVideoBatch(batch, apiKey);
    quotaUnitsUsed += 1; // videos.list costs 1 unit per call regardless of part/id count
    for (const v of items) {
      infoById.set(v.id, v);
    }
    const missing = batch.filter((id) => !items.find((v) => v.id === id));
    if (missing.length) {
      console.warn(`  ⚠ No data returned for: ${missing.join(', ')} (video may be deleted/private)`);
    }
  }

  let updated = 0;
  for (const item of targets) {
    const v = infoById.get(item.youtube_id);
    if (!v) continue;
    item.title = v.snippet?.title || item.title;
    item.author = v.snippet?.channelTitle || item.author;
    item.runtime = parseDuration(v.contentDetails?.duration) || item.runtime;
    if (INCLUDE_DESCRIPTION) {
      item.description = v.snippet?.description || '';
    }
    updated++;
  }

  await writeFile(CONTENT_PATH, JSON.stringify(content, null, 2) + '\n', 'utf8');

  console.log(`\nUpdated ${updated}/${targets.length} items.`);
  console.log(`Approx. YouTube API quota units used: ${quotaUnitsUsed} (default daily quota is 10,000).`);
  console.log(`Wrote ${CONTENT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
