#!/usr/bin/env python3
"""
Verify city data integrity and consistency.

Checks:
- Every city has unique ID and required fields
- Valid city types
- Source files match cities in cities.json (no orphans, no missing entries)
- Testimonials are HTML strings (raw iframes)

Usage:
    python scripts/verify-cities.py
    python scripts/verify-cities.py --fix  # (future: auto-fix some issues)
"""

import json
from pathlib import Path


def verify_cities():
    script_dir = Path(__file__).parent.parent  # my-poland-journey/
    cities_json = script_dir / "data" / "cities.json"
    entries_dir = script_dir / "data" / "city-entries"
    testimonials_dir = script_dir / "data" / "testimonials"

    # Read cities.json
    with open(cities_json) as f:
        cities = json.load(f)

    errors = []
    warnings = []
    seen_ids = set()

    # Invariant 1: Unique IDs
    for city in cities:
        if "id" not in city:
            errors.append("City missing 'id' field")
            continue
        city_id = city["id"]
        if city_id in seen_ids:
            errors.append(f"Duplicate city ID: {city_id}")
        seen_ids.add(city_id)

    # Invariant 2: Required fields
    for city in cities:
        for field in ["id", "name", "lat", "lng", "type"]:
            if field not in city or not city[field]:
                errors.append(
                    f"City {city.get('id', '???')} missing or empty '{field}'"
                )

    # Invariant 3: Valid types
    valid_types = {"community", "ghetto", "camp", "massacre", "synagogue"}
    for city in cities:
        if city.get("type") not in valid_types:
            errors.append(
                f"City {city['id']} has invalid type: {city.get('type')}"
            )

    # Invariant 4: Testimonials are strings
    for city in cities:
        testimonials = city.get("testimonials", [])
        if not isinstance(testimonials, list):
            errors.append(f"City {city['id']}: testimonials is not an array")
        for i, embed in enumerate(testimonials):
            if not isinstance(embed, str):
                errors.append(
                    f"City {city['id']}: testimonials[{i}] is not a string"
                )

    # Invariant 5: Source files consistency
    city_ids = {c["id"] for c in cities}

    # Check for missing entry files
    for city in cities:
        entry_path = entries_dir / f"{city['id']}.html"
        if not entry_path.exists():
            warnings.append(f"Missing entry: {city['id']}.html")

    # Check for orphaned entry files
    if entries_dir.exists():
        for entry_file in entries_dir.glob("*.html"):
            slug = entry_file.stem
            if slug not in city_ids:
                errors.append(
                    f"Orphaned entry file: {entry_file.name} "
                    f"(city '{slug}' not in cities.json)"
                )

    # Check for orphaned testimonials files
    if testimonials_dir.exists():
        for testimonials_file in testimonials_dir.glob("*.json"):
            slug = testimonials_file.stem
            if slug not in city_ids:
                errors.append(
                    f"Orphaned testimonials file: {testimonials_file.name} "
                    f"(city '{slug}' not in cities.json)"
                )

    # Report
    if errors:
        print("❌ ERRORS:")
        for error in errors:
            print(f"   {error}")
    if warnings:
        print("⚠ WARNINGS:")
        for warning in warnings:
            print(f"   {warning}")
    if not errors and not warnings:
        print("✓ All checks passed!")

    return len(errors) == 0


if __name__ == "__main__":
    success = verify_cities()
    exit(0 if success else 1)
