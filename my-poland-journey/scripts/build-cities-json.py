#!/usr/bin/env python3
"""
Build cities.json by merging source files (city-entries/ + testimonials/).

This script is the single point of truth between content source files and the
map's data layer. It reads:
  - data/city-entries/*.html — encyclopedia entries (raw HTML, assumed well-formed)
  - data/testimonials/*.json — YouTube iframe embeds (array of strings)

And produces:
  - data/cities.json — merged with new 'content' and 'testimonials' fields

The script preserves all existing baseline data (id, name, lat, lng, type, source,
source_url) and does not validate or transform HTML/iframes—they are copied as-is.

Usage:
    python scripts/build-cities-json.py
"""

import json
import os
from pathlib import Path


def collect_source_files():
    """
    Stage 1: Scan source directories and read all entry and testimonial files.

    Returns a dict: { "city_slug": { "content": "...", "embeds": [...] } }
    """
    script_dir = Path(__file__).parent.parent  # my-poland-journey/
    entries_dir = script_dir / "data" / "city-entries"
    testimonials_dir = script_dir / "data" / "testimonials"

    registry = {}

    # Scan city entries
    if entries_dir.exists():
        for html_file in sorted(entries_dir.glob("*.html")):
            slug = html_file.stem
            try:
                content = html_file.read_text(encoding="utf-8")
                registry.setdefault(slug, {})["content"] = content
            except Exception as e:
                print(f"⚠ Skipping {html_file.name}: {e}")

    # Scan testimonials
    if testimonials_dir.exists():
        for json_file in sorted(testimonials_dir.glob("*.json")):
            slug = json_file.stem
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
                embeds = data.get("embeds", [])
                if isinstance(embeds, list):
                    registry.setdefault(slug, {})["embeds"] = embeds
                else:
                    print(f"⚠ {json_file.name}: 'embeds' is not an array, skipping")
            except json.JSONDecodeError as e:
                print(f"⚠ Skipping {json_file.name}: invalid JSON ({e})")
            except Exception as e:
                print(f"⚠ Skipping {json_file.name}: {e}")

    return registry


def build_cities_json():
    """
    Stage 2: Load cities.json, merge source files, write atomically.

    For each city in cities.json:
    - If slug has source files, merge in 'content' and 'testimonials' fields.
    - If no source files, leave existing fields unchanged.
    Write the result atomically (temp → replace).
    """
    script_dir = Path(__file__).parent.parent  # my-poland-journey/
    cities_path = script_dir / "data" / "cities.json"

    # Load current cities.json
    try:
        cities = json.loads(cities_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"✗ Failed to read cities.json: {e}")
        return False

    # Collect source files
    registry = collect_source_files()

    # Merge
    cities_updated = 0
    for city in cities:
        city_id = city.get("id")
        if not city_id:
            print(f"⚠ Skipping city with missing 'id'")
            continue

        if city_id in registry:
            source = registry[city_id]
            if "content" in source:
                city["content"] = source["content"]
            if "embeds" in source:
                city["testimonials"] = source["embeds"]
            cities_updated += 1

    # Write atomically
    try:
        temp_path = cities_path.with_suffix(".json.tmp")
        temp_path.write_text(
            json.dumps(cities, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        temp_path.replace(cities_path)
    except Exception as e:
        print(f"✗ Failed to write cities.json: {e}")
        return False

    # Log summary
    total_entries = len([s for s in registry.values() if "content" in s])
    total_embeds = len([s for s in registry.values() if "embeds" in s])
    print(f"✓ {cities_updated} cities updated")
    print(f"  - {total_entries} city entries merged from data/city-entries/")
    print(f"  - {total_embeds} testimonial files merged from data/testimonials/")
    print(f"✓ Written to {cities_path}")

    return True


if __name__ == "__main__":
    success = build_cities_json()
    exit(0 if success else 1)
