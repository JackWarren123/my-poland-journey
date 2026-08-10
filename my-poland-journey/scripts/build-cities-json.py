#!/usr/bin/env python3
"""
Validate cities.json structure.

Content (videos, articles) now lives in data/content.json — there are no
longer separate source directories to merge. This script checks cities.json
for structural integrity.

Usage:
    python scripts/build-cities-json.py
"""

import json
import sys
from pathlib import Path

VALID_TYPES = {"community", "ghetto", "camp", "massacre", "synagogue"}
REQUIRED_FIELDS = ["id", "name", "lat", "lng", "type"]

script_dir = Path(__file__).parent.parent
cities_path = script_dir / "data" / "cities.json"

try:
    cities = json.loads(cities_path.read_text(encoding="utf-8"))
except Exception as e:
    print(f"✗ Failed to read cities.json: {e}")
    sys.exit(1)

errors = []
seen_ids = set()

for city in cities:
    city_id = city.get("id", "???")
    if city_id in seen_ids:
        errors.append(f"Duplicate city ID: {city_id}")
    seen_ids.add(city_id)

    for field in REQUIRED_FIELDS:
        if not city.get(field):
            errors.append(f"{city_id}: missing or empty '{field}'")

    if city.get("type") not in VALID_TYPES:
        errors.append(f"{city_id}: invalid type '{city.get('type')}'")

if errors:
    print("❌ ERRORS:")
    for e in errors:
        print(f"   {e}")
    sys.exit(1)

print(f"✓ {len(cities)} cities OK")
