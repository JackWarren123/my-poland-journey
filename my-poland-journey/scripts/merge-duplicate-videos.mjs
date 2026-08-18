// One-off / re-runnable cleanup script.
// Some videos relevant to multiple cities were added as separate content.json
// items (one per city) instead of one item with multiple places — e.g.
// "auschwitz_bzrXrJip4fA" and "lodz_bzrXrJip4fA" for the same youtube_id.
// That makes the same video show up twice in "All Content" instead of once
// with both city tags. This merges any items that share a youtube_id (and
// are otherwise identical apart from id/places) into a single item whose
// places array covers every city, keeping the first item's id.
//
// If two items share a youtube_id but differ in title/author/runtime/
// content_type/form, they're left alone and reported — that'd mean they're
// not actually the same video entry and need a human look.
//
// Usage:
//   cd my-poland-journey
//   node scripts/merge-duplicate-videos.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = path.join(__dirname, '..', 'data', 'content.json');

const MERGEABLE_FIELDS = ['title', 'author', 'form', 'runtime', 'youtube_id', 'content_type'];

async function main() {
  const raw = await readFile(CONTENT_PATH, 'utf8');
  const content = JSON.parse(raw);

  const groups = new Map(); // youtube_id -> items, in original order
  for (const item of content) {
    if (!item.youtube_id) continue;
    if (!groups.has(item.youtube_id)) groups.set(item.youtube_id, []);
    groups.get(item.youtube_id).push(item);
  }

  const toRemove = new Set();
  let merged = 0;
  let skipped = 0;

  for (const [ytId, items] of groups) {
    if (items.length < 2) continue;

    const [first, ...rest] = items;
    const mismatched = rest.some((item) =>
      MERGEABLE_FIELDS.some((field) => item[field] !== first[field])
    );

    if (mismatched) {
      console.warn(`⚠ Skipping ${ytId}: items differ beyond id/places, needs a human look.`);
      skipped++;
      continue;
    }

    const places = [...new Set(items.flatMap((item) => item.places || []))];
    first.places = places;
    for (const item of rest) toRemove.add(item);

    console.log(`${first.id}: merged ${items.map((i) => i.id).join(', ')} -> places [${places.join(', ')}]`);
    merged++;
  }

  if (merged === 0) {
    console.log(skipped ? `Nothing merged (${skipped} group(s) skipped, see warnings above).` : 'Nothing to merge.');
    return;
  }

  const deduped = content.filter((item) => !toRemove.has(item));
  await writeFile(CONTENT_PATH, JSON.stringify(deduped, null, 2) + '\n', 'utf8');
  console.log(`\nMerged ${merged} duplicate video(s), removed ${toRemove.size} item(s). Wrote ${CONTENT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
