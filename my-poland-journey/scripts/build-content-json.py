#!/usr/bin/env python3
"""
Build content.json: the centralized content registry.

Reads:
  - data/short-videos/*.json      -> video items  (content_type: "short_video")
  - data/full-testimonials/*.json -> video items  (content_type: "full_testimonial")
  - data/cities.json              -> article items for cities with HTML content

Produces:
  - data/content.json  (flat array; one item per piece of content)

Each item:
  {
    "id":           "{city-id}_{youtube-id}"  or "{city-id}_article",
    "title":        "",          # fill in later
    "author":       "",          # fill in later
    "form":         "video" | "article",
    "runtime":      "" | null,   # e.g. "12:34"; null for articles
    "youtube_id":   "abc123" | null,
    "places":       ["warsaw"],  # city IDs this content is tagged with
    "content_type": "short_video" | "full_testimonial" | "article"
  }

Usage:
    python scripts/build-content-json.py
"""

import json
import re
from pathlib import Path


def extract_youtube_id(embed_str):
    m = re.search(r'/embed/([a-zA-Z0-9_-]{11})', embed_str)
    return m.group(1) if m else None


def load_video_items(directory, content_type):
    items = []
    if not directory.exists():
        return items
    for json_file in sorted(directory.glob("*.json")):
        city_id = json_file.stem
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
            for embed in data.get("embeds", []):
                yt_id = extract_youtube_id(embed)
                if not yt_id:
                    print(f"  ⚠ No YouTube ID in {json_file.name}: {embed[:60]}")
                    continue
                items.append({
                    "id": f"{city_id}_{yt_id}",
                    "title": "",
                    "author": "",
                    "form": "video",
                    "runtime": "",
                    "youtube_id": yt_id,
                    "places": [city_id],
                    "content_type": content_type,
                })
        except Exception as e:
            print(f"  ⚠ Skipping {json_file.name}: {e}")
    return items


def build_content_json():
    base = Path(__file__).parent.parent  # my-poland-journey/

    items = []

    short = load_video_items(base / "data" / "short-videos", "short_video")
    items.extend(short)
    print(f"  {len(short)} short video items")

    full = load_video_items(base / "data" / "full-testimonials", "full_testimonial")
    items.extend(full)
    print(f"  {len(full)} full testimonial items")

    cities_path = base / "data" / "cities.json"
    try:
        cities = json.loads(cities_path.read_text(encoding="utf-8"))
        article_count = 0
        for city in cities:
            content = city.get("content", "")
            text = re.sub(r'<!--[\s\S]*?-->', '', content)
            text = re.sub(r'<[^>]+>', '', text).strip()
            if text:
                items.append({
                    "id": f"{city['id']}_article",
                    "title": city.get("name", ""),
                    "author": "",
                    "form": "article",
                    "runtime": None,
                    "youtube_id": None,
                    "places": [city["id"]],
                    "content_type": "article",
                })
                article_count += 1
        print(f"  {article_count} article items")
    except Exception as e:
        print(f"  ⚠ Could not read cities.json: {e}")

    out_path = base / "data" / "content.json"
    tmp = out_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(out_path)
    print(f"✓ {len(items)} total items → {out_path}")
    return True


if __name__ == "__main__":
    exit(0 if build_content_json() else 1)
