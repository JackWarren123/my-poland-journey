// One-off / re-runnable cleanup script.
// YouTube titles are capped at 100 characters. Yad Vashem testimony videos are
// titled "Testimony of [name], born in ..., regarding ..." / "עדות/עדותו/עדותה
// של [שם], ילידת/יליד ..." — the interesting part (the name) survives the
// truncation, but the rest is really description content that gets cut off
// mid-word. This trims those titles down to "Testimony of [name]" /
// "עדות(ו/ה) של [name]" by keeping everything up to the first delimiter that
// introduces the birth/experience clause.
//
// Hebrew titles don't always use a comma before that clause — some go
// straight from the name into "יליד"/"ילידת" (born) with just a space, e.g.
// "עדותו של פרנקל זליג יליד Działoszyce..." — so the delimiter search covers
// both.
//
// Usage:
//   cd my-poland-journey
//   node scripts/trim-testimony-titles.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = path.join(__dirname, '..', 'data', 'content.json');

const PREFIXES = ['Testimony of', 'עדות של', 'עדותו של', 'עדותה של'];

// Whichever of these appears first marks the start of the "born in .../
// יליד(ת) ..." clause that should be dropped.
const DELIMITER = /,| ילידת | יליד /;

function trimTitle(title) {
  const prefix = PREFIXES.find((p) => title.startsWith(p));
  if (!prefix) return title;
  const match = DELIMITER.exec(title);
  if (!match) return title; // already trimmed / no trailing clause
  return title.slice(0, match.index).trim();
}

async function main() {
  const raw = await readFile(CONTENT_PATH, 'utf8');
  const content = JSON.parse(raw);

  let changed = 0;
  for (const item of content) {
    if (item.form !== 'video' || !item.title) continue;
    const trimmed = trimTitle(item.title);
    if (trimmed !== item.title) {
      console.log(`${item.title}\n  -> ${trimmed}\n`);
      item.title = trimmed;
      changed++;
    }
  }

  if (changed === 0) {
    console.log('Nothing to trim.');
    return;
  }

  await writeFile(CONTENT_PATH, JSON.stringify(content, null, 2) + '\n', 'utf8');
  console.log(`Trimmed ${changed} title(s). Wrote ${CONTENT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
