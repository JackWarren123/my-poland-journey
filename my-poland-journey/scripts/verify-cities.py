#!/usr/bin/env python3
"""
Verify data integrity across cities.json and content.json.

Checks:
  cities.json  — unique IDs, required fields, valid types
  content.json — required fields, valid content_type, valid place references,
                 youtube_id present for videos, body present for articles

Usage:
    python scripts/verify-cities.py
"""

import json
import sys
from pathlib import Path

VALID_CITY_TYPES = {"community", "ghetto", "camp", "massacre", "synagogue"}
VALID_CONTENT_TYPES = {"short_video", "full_testimonial", "article"}

script_dir = Path(__file__).parent.parent
cities_path = script_dir / "data" / "cities.json"
content_path = script_dir / "data" / "content.json"

errors = []
warnings = []

# --- cities.json ---
try:
    cities = json.loads(cities_path.read_text(encoding="utf-8"))
except Exception as e:
    print(f"✗ Cannot read cities.json: {e}")
    sys.exit(1)

city_ids = set()
for city in cities:
    cid = city.get("id", "???")
    if cid in city_ids:
        errors.append(f"cities.json: duplicate ID '{cid}'")
    city_ids.add(cid)

    for field in ["id", "name", "lat", "lng", "type"]:
        if not city.get(field):
            errors.append(f"cities.json [{cid}]: missing '{field}'")

    if city.get("type") not in VALID_CITY_TYPES:
        errors.append(f"cities.json [{cid}]: invalid type '{city.get('type')}'")

# --- content.json ---
try:
    content = json.loads(content_path.read_text(encoding="utf-8"))
except Exception as e:
    print(f"✗ Cannot read content.json: {e}")
    sys.exit(1)

content_ids = set()
for item in content:
    iid = item.get("id", "???")
    if iid in content_ids:
        errors.append(f"content.json: duplicate ID '{iid}'")
    content_ids.add(iid)

    ct = item.get("content_type")
    if ct not in VALID_CONTENT_TYPES:
        errors.append(f"content.json [{iid}]: invalid content_type '{ct}'")

    if ct == "article" and not item.get("body"):
        warnings.append(f"content.json [{iid}]: article has no body")

    if ct in ("short_video", "full_testimonial") and not item.get("youtube_id"):
        errors.append(f"content.json [{iid}]: video missing youtube_id")

    for place_id in item.get("places", []):
        if place_id not in city_ids:
            errors.append(f"content.json [{iid}]: unknown place '{place_id}'")

# --- Report ---
if errors:
    print("❌ ERRORS:")
    for e in errors:
        print(f"   {e}")
if warnings:
    print("⚠ WARNINGS:")
    for w in warnings:
        print(f"   {w}")
if not errors and not warnings:
    print(f"✓ All checks passed! ({len(cities)} cities, {len(content)} content items)")

sys.exit(0 if not errors else 1)
