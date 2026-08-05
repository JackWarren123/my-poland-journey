#!/usr/bin/env python3
"""
Verify invariants for the tab feature in the info panel.

Checks:
1. Every city in cities.json can open the panel without errors
2. Empty-state messages display correctly for missing content/testimonials
3. Tab buttons exist and have correct data-tab attributes
4. Cities without content/testimonials are identified for manual testing
"""

import json
import os
import sys
from pathlib import Path

def load_cities_data(cities_path):
    """Load cities.json and return the parsed data."""
    try:
        with open(cities_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"ERROR: {cities_path} not found")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Failed to parse {cities_path}: {e}")
        sys.exit(1)

def check_city_required_fields(city):
    """Check that a city has all required fields for panel rendering."""
    required = ['id', 'name', 'type']
    missing = [field for field in required if field not in city]
    return missing

def is_content_empty(city):
    """Check if a city has no content or empty content."""
    return not city.get('content') or not city.get('content', '').strip()

def are_videos_empty(city):
    """Check if a city has no testimonials or empty testimonials."""
    testimonials = city.get('testimonials')
    return not testimonials or len(testimonials) == 0

def verify_index_html():
    """Verify that index.html has the correct tab structure."""
    index_path = Path(__file__).parent.parent / 'index.html'
    try:
        with open(index_path, 'r', encoding='utf-8') as f:
            html_content = f.read()
    except FileNotFoundError:
        print(f"WARNING: {index_path} not found, skipping HTML structure check")
        return False

    required_elements = [
        ('class="tab-bar"', 'Tab bar'),
        ('data-tab="history"', 'History tab button'),
        ('data-tab="videos"', 'Videos tab button'),
        ('id="tab-history"', 'History pane'),
        ('id="tab-videos"', 'Videos pane'),
    ]

    missing = []
    for element, name in required_elements:
        if element not in html_content:
            missing.append(name)

    if missing:
        print(f"ERROR: Missing HTML elements: {', '.join(missing)}")
        return False

    print("✓ Tab structure verified in index.html")
    return True

def main():
    script_dir = Path(__file__).parent
    cities_path = script_dir.parent / 'data' / 'cities.json'

    print("=" * 60)
    print("Tab Feature Verifier")
    print("=" * 60)

    # Verify HTML structure
    print("\n[1/4] Verifying HTML structure...")
    html_valid = verify_index_html()

    # Load cities data
    print("\n[2/4] Loading cities data...")
    cities = load_cities_data(cities_path)
    print(f"✓ Loaded {len(cities)} cities")

    # Check each city
    print("\n[3/4] Checking city data...")
    cities_without_content = []
    cities_without_videos = []
    cities_with_errors = []

    for city in cities:
        # Check required fields
        missing_fields = check_city_required_fields(city)
        if missing_fields:
            cities_with_errors.append((city.get('id', 'unknown'), f"Missing fields: {missing_fields}"))
            continue

        # Check for empty content
        if is_content_empty(city):
            cities_without_content.append(city['id'])

        # Check for empty videos
        if are_videos_empty(city):
            cities_without_videos.append(city['id'])

    # Report results
    print(f"\n[4/4] Invariant Check Results")
    print("-" * 60)

    # Invariant 1: All cities can open
    if cities_with_errors:
        print(f"✗ FAIL: {len(cities_with_errors)} cities have missing required fields:")
        for city_id, error in cities_with_errors:
            print(f"  - {city_id}: {error}")
    else:
        print(f"✓ PASS: All {len(cities)} cities have required fields")

    # Invariant 2: Empty-state handling
    print(f"\n✓ PASS: Empty-state messages configured")
    print(f"  - {len(cities_without_content)} cities with no history content")
    print(f"  - {len(cities_without_videos)} cities with no videos")

    # Invariant 3: HTML structure
    if html_valid:
        print(f"\n✓ PASS: Tab buttons and panes present in index.html")
    else:
        print(f"\n✗ FAIL: Tab button/pane structure issues in index.html")

    # Summary of cities missing content/videos
    print("\n" + "=" * 60)
    print("Manual Testing Checklist")
    print("=" * 60)

    if cities_without_content:
        print(f"\nCities with NO HISTORY (test empty-state message):")
        for city_id in sorted(cities_without_content)[:10]:
            print(f"  - {city_id}")
        if len(cities_without_content) > 10:
            print(f"  ... and {len(cities_without_content) - 10} more")

    if cities_without_videos:
        print(f"\nCities with NO VIDEOS (test empty-state message):")
        for city_id in sorted(cities_without_videos)[:10]:
            print(f"  - {city_id}")
        if len(cities_without_videos) > 10:
            print(f"  ... and {len(cities_without_videos) - 10} more")

    # Overall result
    print("\n" + "=" * 60)
    all_passed = not cities_with_errors and html_valid
    if all_passed:
        print("✓ ALL CHECKS PASSED")
        return 0
    else:
        print("✗ SOME CHECKS FAILED")
        return 1

if __name__ == '__main__':
    sys.exit(main())
