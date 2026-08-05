# My Poland Journey — Interactive Map

An interactive map of Jewish life and the Holocaust in Poland. Click a city pin to read its history in a side panel.

## Running Locally

The site fetches `data/cities.json` at runtime, so it must be served over HTTP (not `file://`).

```bash
cd my-poland-journey
python3 -m http.server 8000
# open http://localhost:8000
```

## Content Tabs

Each city has three tabs in its info panel:

1. **History** — Encyclopedia entry about the city's Jewish history
2. **Short Videos** — Brief video testimonials from survivors and witnesses
3. **Full Testimonials** — Longer, full-length video testimonials

### Adding Videos

**Short Videos:** Edit `data/short-videos/{city-id}.json`
**Full Testimonials:** Edit `data/full-testimonials/{city-id}.json`

Both files contain an `embeds` array of YouTube video links. Files are created automatically for each city by the build script.

#### Supported Link Formats

The system accepts both regular YouTube links and full embed iframes:

**Regular links (recommended):**
- Short form: `https://youtu.be/videoId`
- Long form: `https://www.youtube.com/watch?v=videoId`
- With parameters: `https://youtu.be/videoId?si=...` or `https://www.youtube.com/watch?v=videoId&t=30s`

**Embed iframes:**
- Full HTML: `<iframe width="560" height="315" src="https://www.youtube.com/embed/videoId" ...></iframe>`

### Example

```json
{
  "embeds": [
    "https://youtu.be/kVMsDl7nRus",
    "https://www.youtube.com/watch?v=jk-sJADfWrU&t=10s",
    "<iframe width=\"560\" height=\"315\" src=\"https://www.youtube.com/embed/bWf-nBhaL4E\" ...></iframe>"
  ]
}
```

### How It Works

1. **Data entry:** Users paste YouTube links directly into `data/testimonials/{city-id}.json`
2. **Build step:** `scripts/build-cities-json.py` merges testimonials into `cities.json`
3. **Rendering:** `js/map.js` detects the link format:
   - Regular links are converted to embed URLs
   - Embed iframes are passed through unchanged
   - All videos render with consistent styling

### Known Rough Edges

- Invalid YouTube links fail silently in the browser (no error message)
- Query parameters like `?si=` are stripped from regular links (they're not needed for playback)
- There is no UI form for adding testimonials; users must edit JSON files directly

## Building the Data Pipeline

The site is built from source files using `scripts/build-cities-json.py`:

```bash
python3 my-poland-journey/scripts/build-cities-json.py
```

This script merges:
- `data/city-entries/*.html` — Encyclopedia entries (one per city)
- `data/testimonials/*.json` — Video testimonials (one per city)
- Into: `data/cities.json` — Final data file loaded by the map

Run the verifier to check for inconsistencies:

```bash
python3 my-poland-journey/scripts/verify-cities.py
```

## File Structure

```
my-poland-journey/
├── index.html                    # Single-page app entry point
├── js/map.js                     # D3 map rendering + testimonials logic
├── css/style.css                 # All styling
├── data/
│   ├── cities.json              # Generated: merged city data
│   ├── city-entries/            # Encyclopedia entries (*.html)
│   ├── testimonials/            # Video testimonials (*.json)
│   ├── poland_modern.geojson    # Modern Poland borders
│   └── poland_1939.geojson      # 1939 Poland borders (dashed underlay)
└── scripts/
    ├── build-cities-json.py     # Merge source files into cities.json
    ├── verify-cities.py         # Validate data integrity
    └── bootstrap-entries.py     # Generate stub files for new cities
```

## Technologies

- **No framework, no build step, no bundler** — Plain static site
- [D3 v7](https://d3js.org/) — Map rendering and interactivity
- [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) — Video playback

## License & Attribution

See the root repository for license and attribution information.