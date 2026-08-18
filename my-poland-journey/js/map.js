// "ghetto" is intentionally mapped to the same color/label as "community":
// which prewar communities are tagged "ghetto" in cities.json is inconsistent
// (many more cities had ghettos than are marked as such), so the map no
// longer visually singles them out. The underlying city.type value is left
// alone in cities.json — this only affects how it's colored/labeled.
const PIN_COLORS = {
  community: '#3a7bc8',
  ghetto:    '#3a7bc8',
  camp:      '#b02820',
  massacre:  '#7b3a9e',
  synagogue: '#1e8a4a',
};

const TYPE_LABELS = {
  community: 'Jewish Community',
  ghetto:    'Jewish Community',
  camp:      'Extermination / Concentration Camp',
  massacre:  'Massacre Site',
  synagogue: 'Synagogue',
};

// Display labels for content_type in the panel list meta line.
// full_testimonial is intentionally omitted — the underlying
// content_type value is kept on every item for future tag-based
// filtering, it's just not shown as a label right now.
const CONTENT_TYPE_LABELS = {
  article: 'Article',
};

const CONTENT_TYPE_ORDER = ['article', 'short_video', 'full_testimonial'];

// The real deployed website — used as a genuine https:// origin for
// embedding YouTube videos from the native app (see youtube-embed.html
// and renderPanelDetail's video branch for why).
const LIVE_SITE_ORIGIN = 'https://my-poland-journey.netlify.app';

let activePinId = null;

let panelState = {
  open: false,
  cityId: null,      // null = all content, string = filtered to city
  detailItem: null,  // null = list view, item object = detail view
  items: null,        // list items for the current panel, computed once per open so
                       // navigating back from a detail view shows the same order
                       // (in particular, the same random shuffle for "All Content")
};

// When a city panel is opened from another menu (Nearest Places, Find a
// City, a saved video in Account) rather than directly from a map pin, this
// holds how to get back to that menu. { onBack: () => void } | null.
let panelReturnTo = null;

function updatePanelBackVisibility() {
  const showBack = panelState.detailItem !== null || panelReturnTo !== null;
  document.getElementById('panel-back').classList.toggle('hidden', !showBack);
}

// The title to restore when backing out of a detail item to the list.
function getPanelListTitle() {
  if (panelState.cityId) {
    const city = citiesData.find((c) => c.id === panelState.cityId);
    return city ? city.name : '';
  }
  return 'All Content';
}

// YouTube IFrame API state
let youtubeAPIReady = false;

// Lifted to module scope so the nearest-places feature can invert clicks and
// read the city list after init().
let projection = null;
let citiesData = [];
let contentData = [];      // all items from content.json
let contentByCity = {};    // { cityId: [...items] } index built at load time
let selectMode = false;

// Double-tap zoom state. The map layers live in `zoomGroup`; `zoomTransform`
// mirrors the group's current transform so click->lat/lng inversion stays correct.
let zoomGroup = null;
let zoomTransform = { k: 1, x: 0, y: 0 };
const ZOOM_FACTOR = 6; // how far a double-tap zooms in

// "You are here" map dot (Settings > Share Your Location).
let layerUserLocation = null;
let modernGeo = null;
let border1939Geo = null;
let userLocation = null;      // { lat, lng } or null
let userHeading = null;       // degrees 0-359 (true/magnetic north), or null if unknown
let locationWatchId = null;   // string (native) or number (web) watch handle
let compassListenerActive = false;

const USER_LOCATION_CONE_PATH = 'M0,0 L-11.66,-18.66 A22,22 0 0,1 11.66,-18.66 Z';
const USER_LOCATION_DOT_R = 6;
// City pins (camp type) are r=2.25 and scale directly with zoom (no counter-
// scaling). 0.375 = 2.25/6, so past k≈2.67 the "you are here" dot's counter-
// scale bottoms out and it starts growing at the same rate as pins instead of
// shrinking below them — it just never gets bigger than its k=1 size until
// pins catch up to that size too.
const USER_LOCATION_MIN_SCALE = 0.375;

function userLocationScaleFactor() {
  return Math.max(1 / zoomTransform.k, USER_LOCATION_MIN_SCALE);
}


function getMapDimensions() {
  return { width: window.innerWidth, height: window.innerHeight };
}

// Attach swipe-to-dismiss to a bottom-sheet panel. Dragging the handle pill
// downward by 80px+ (or quickly flicking) closes the panel via closeFn.
function makeSwipeable(panelEl, closeFn) {
  const handle = panelEl.querySelector('.sheet-handle');
  if (!handle) return;

  let startY = 0;
  let currentY = 0;
  let startTime = 0;
  let active = false;

  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    currentY = startY;
    startTime = Date.now();
    active = true;
    panelEl.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    if (!active) return;
    currentY = e.touches[0].clientY;
    const delta = Math.max(0, currentY - startY);
    panelEl.style.transform = `translateY(${delta}px)`;
  }, { passive: true });

  function onRelease() {
    if (!active) return;
    active = false;
    const delta = Math.max(0, currentY - startY);
    const velocity = delta / Math.max(1, Date.now() - startTime); // px/ms
    panelEl.style.transition = '';

    if (delta > 80 || velocity > 0.5) {
      panelEl.style.transform = 'translateY(100%)';
      panelEl.addEventListener('transitionend', function onEnd() {
        panelEl.removeEventListener('transitionend', onEnd);
        panelEl.style.transform = '';
        closeFn();
      }, { once: true });
    } else {
      panelEl.style.transform = '';
    }
  }

  handle.addEventListener('touchend', onRelease, { passive: true });
  handle.addEventListener('touchcancel', onRelease, { passive: true });
}

// ---- City label placement ----
//
// Labels used to be drawn at a fixed offset (bottom-right of the pin), which
// in dense clusters (e.g. central Poland) piles labels on top of each other.
// This is the classic cartography "point-feature label placement" problem —
// professionally drawn maps solve it by hand, nudging each label to whichever
// side has room. We approximate that with a small greedy algorithm: for each
// city, in order, try 8 candidate positions around the pin (following the
// traditional point-label priority — right/corners first, then directly
// above/below, which reads best) and use the first one that doesn't overlap
// any pin or any label already placed. If every candidate collides with
// something, fall back to whichever collides the least.
//
// This only needs to run once per layout (init/resize) — panning and
// zooming apply a CSS transform to the whole zoom-group rather than
// re-projecting, so relative label/pin positions (and therefore collisions)
// don't change as the user zooms.
const LABEL_FONT_SIZE = 2.5; // must match .city-label's font-size in style.css
const LABEL_FONT = `${LABEL_FONT_SIZE}px Georgia, serif`; // must match .city-label's font in style.css
const LABEL_HEIGHT = LABEL_FONT_SIZE * 1.2; // approx cap+descender height
const LABEL_CLEARANCE = 1; // gap left between the pin's own edge and the label
const LABEL_NEARBY_RADIUS = 15; // how close another pin must be to risk being mistaken for this label's own

// (dx, dy) offset from the pin center to the label's anchor point, and the
// text-anchor that keeps the label growing away from the pin at that offset.
// `gap` is per-city (pin radius + clearance) so the label sits as close to
// its own pin as it can without touching it — camp pins are drawn larger
// (r=3 vs r=2), so a flat gap left labels next to a camp less tightly
// hugged (and easier to mistake for a neighboring pin's label) than labels
// next to a community pin.
//
// The diagonal (corner) candidates use a smaller factor of `gap` on each
// axis than the cardinal ones — cutting the corner is what makes them
// visually "diagonal" rather than just a farther-out cardinal position.
// DIAGONAL_FACTOR must stay large enough that the anchor still clears the
// pin's own (square-approximated) bounding box after LABEL_COLLISION_PAD is
// applied — 0.75 looked reasonable geometrically but left both a community
// and (worse) a camp pin's corner still inside the padded box, which is
// exactly why label text kept grazing its own dot.
const DIAGONAL_FACTOR = 0.9;

function labelCandidates(gap) {
  const d = gap * DIAGONAL_FACTOR;
  // 'above'/'below' are vertically centered on the anchor (dominant-baseline:
  // middle), so half the label's own height reaches back toward the pin —
  // unlike the side candidates, where the text grows away from the anchor
  // and never reaches back over the pin at all. Give them the extra
  // clearance so their real gap from the pin matches every other candidate
  // instead of being quietly thinner (or negative, once padded).
  const verticalGap = gap + LABEL_HEIGHT / 2 + LABEL_COLLISION_PAD;
  return [
    { name: 'upper-right', dx: d,  dy: -d, anchor: 'start' },
    { name: 'right',       dx: gap, dy: 0,  anchor: 'start' },
    { name: 'lower-right', dx: d,  dy: d,  anchor: 'start' },
    { name: 'above',       dx: 0,  dy: -verticalGap, anchor: 'middle' },
    { name: 'below',       dx: 0,  dy: verticalGap,  anchor: 'middle' },
    { name: 'upper-left',  dx: -d, dy: -d, anchor: 'end' },
    { name: 'left',        dx: -gap, dy: 0, anchor: 'end' },
    { name: 'lower-left',  dx: -d, dy: d,  anchor: 'end' },
  ];
}

// canvas measureText() gives advance width, not exact glyph ink extent, and
// LABEL_HEIGHT is an approximation rather than measured font metrics — pad
// the box slightly for collision purposes so that estimation slack can't
// turn a "just clearing" candidate into a visible overlap once actually
// rendered (checked against SVG getBBox()).
const LABEL_COLLISION_PAD = 0.4;

function labelBox(anchorX, anchorY, textWidth, anchor) {
  const w = textWidth + LABEL_COLLISION_PAD * 2;
  const h = LABEL_HEIGHT + LABEL_COLLISION_PAD * 2;
  const left = (anchor === 'start' ? anchorX : anchor === 'end' ? anchorX - textWidth : anchorX - textWidth / 2) - LABEL_COLLISION_PAD;
  return { left, right: left + w, top: anchorY - h / 2, bottom: anchorY + h / 2 };
}

function pinRadius(d) {
  return d.type === 'camp' ? 2.25 : 1.5;
}

function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

// A big soft penalty (rather than an outright ban) for two kinds of
// placement that don't literally overlap a box but still read as wrong:
// sitting on top of a border line, or landing closer to a *different*
// city's pin than to the label's own pin (which is exactly what made
// Dębica's label look like it belonged to Rzeszów). Kept as a penalty
// rather than a hard rule so an extremely cramped cluster still gets a
// "least bad" placement instead of no placement at all.
const SOFT_PENALTY = 1000;

// Rasterize both border layers once into a shared offscreen canvas so
// candidate boxes can be tested against actual border pixels (cheap array
// reads) instead of doing per-candidate geometry/path math.
function rasterizeBorders(modern, border1939, projection, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const ctx = canvas.getContext('2d');
  const pathGen = d3.geoPath().projection(projection).context(ctx);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  [modern, border1939].forEach((fc) => {
    (fc.features || []).forEach((f) => {
      ctx.beginPath();
      pathGen(f);
      ctx.stroke();
    });
  });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height };
}

function boxHitsBorder(box, raster) {
  const x0 = Math.max(0, Math.floor(box.left));
  const x1 = Math.min(raster.width - 1, Math.ceil(box.right));
  const y0 = Math.max(0, Math.floor(box.top));
  const y1 = Math.min(raster.height - 1, Math.ceil(box.bottom));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (raster.data[(y * raster.width + x) * 4 + 3] > 0) return true;
    }
  }
  return false;
}

// Explicit direction overrides for cities where the greedy algorithm's pick
// didn't match how the map should actually read — placed unconditionally at
// the tight ring (still registered as an obstacle for every other label).
// References one of labelCandidates()'s named positions rather than raw
// dx/dy so the override always gets the same real clearance as everything
// else the algorithm places, instead of duplicating (and risking drifting
// out of sync with) that geometry by hand.
const LABEL_OVERRIDES = {
  sosnowiec: 'right',
  'bielsko-biala': 'below',
  auschwitz: 'lower-right',
  gdynia: 'lower-left',
  gdansk: 'below',
  chelmno: 'below',
  bialystok: 'left',
  suwalki: 'above',
  augustow: 'below',
  warsaw: 'upper-left',
  'miedzyrzec-podlaski': 'below',
  'minsk-mazowiecki': 'above',
  kutno: 'above',
  lowicz: 'above',
  krotoszyn: 'above',
};

function placeCityLabels(cities, projection, modern, border1939, width, height) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = LABEL_FONT;

  const raster = rasterizeBorders(modern, border1939, projection, width, height);

  // Every pin is an obstacle for every label, regardless of processing order.
  const pinCenters = cities.map((d) => projection([d.lng, d.lat]));
  const pinBoxes = cities.map((d, i) => {
    const [x, y] = pinCenters[i];
    const r = pinRadius(d);
    return { left: x - r, right: x + r, top: y - r, bottom: y + r };
  });

  const placedLabelBoxes = [];

  return cities.map((d, i) => {
    const [px, py] = pinCenters[i];
    const textWidth = ctx.measureText(d.name).width;
    const gap = pinRadius(d) + LABEL_CLEARANCE;

    if (LABEL_OVERRIDES[d.id]) {
      const c = labelCandidates(gap).find((cand) => cand.name === LABEL_OVERRIDES[d.id]);
      const anchorX = px + c.dx;
      const anchorY = py + c.dy;
      const box = labelBox(anchorX, anchorY, textWidth, c.anchor);
      placedLabelBoxes.push(box);
      return { ...d, labelX: anchorX, labelY: anchorY, anchor: c.anchor };
    }

    // Pins worth checking a candidate's "closer to me or to them" distance
    // against — scoped to nearby ones only. With 146 cities spread across
    // the whole country, checking against every pin means almost any
    // direction has *some* slightly-closer pin somewhere far away, which
    // vetoed otherwise-fine tight placements nearly everywhere. Only a
    // genuinely nearby pin can actually be mistaken for this label's own.
    const nearbyPinIndices = [];
    for (let j = 0; j < pinCenters.length; j++) {
      if (j === i) continue;
      const [ox, oy] = pinCenters[j];
      if (Math.hypot(px - ox, py - oy) < LABEL_NEARBY_RADIUS) nearbyPinIndices.push(j);
    }

    let best = null;
    let bestOverlap = Infinity;

    // Try the tight ring first (hugging the pin, per LABEL_CLEARANCE) so
    // most labels sit right next to their own pin. Only cities crowded
    // enough that every tight candidate collides with something fall
    // through to progressively wider rings, kept modest (up to 1.6x) so a
    // crowded label lands a little further out rather than drifting so far
    // it reads as belonging to a different pin. A last, wider 2.2x ring
    // exists only for the rare city boxed in on every side at 1.6x — e.g. a
    // coastal city (Gdańsk) sitting right at a tight border curve, where
    // every close candidate crosses the border line itself.
    for (const ringGap of [gap, gap * 1.3, gap * 1.6, gap * 2.2]) {
      for (const c of labelCandidates(ringGap)) {
        const anchorX = px + c.dx;
        const anchorY = py + c.dy;
        const box = labelBox(anchorX, anchorY, textWidth, c.anchor);

        let overlap = 0;
        for (const obstacle of pinBoxes) overlap += overlapArea(box, obstacle);
        for (const obstacle of placedLabelBoxes) overlap += overlapArea(box, obstacle);
        if (boxHitsBorder(box, raster)) overlap += SOFT_PENALTY;

        // Reject (via penalty) any candidate whose anchor sits closer to a
        // nearby different city's pin than to its own — even with zero box
        // overlap, that reads as mislabeling the wrong pin.
        const ownDist = Math.hypot(c.dx, c.dy);
        for (const j of nearbyPinIndices) {
          const [ox, oy] = pinCenters[j];
          if (Math.hypot(anchorX - ox, anchorY - oy) < ownDist) {
            overlap += SOFT_PENALTY;
            break;
          }
        }

        if (overlap === 0) {
          best = { labelX: anchorX, labelY: anchorY, anchor: c.anchor, box };
          bestOverlap = 0;
          break;
        }
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          best = { labelX: anchorX, labelY: anchorY, anchor: c.anchor, box };
        }
      }
      if (bestOverlap === 0) break;
    }

    placedLabelBoxes.push(best.box);
    return { ...d, labelX: best.labelX, labelY: best.labelY, anchor: best.anchor };
  });
}

function buildProjection(width, height) {
  // Center on the midpoint of the 1939 borders (lng 15.8–28.4 → ~22.1, lat 47.9–55.8 → ~51.8).
  // Scale reduced so the full dashed eastern border fits within the viewport.
  const scale = Math.min(width * 3.0, height * 3.8);
  return d3.geoMercator()
    .center([21.0, 51.8])
    .scale(scale)
    .translate([width / 2, height / 2]);
}

function init() {
  const { width, height } = getMapDimensions();

  const svg = d3.select('#map')
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  projection = buildProjection(width, height);
  const path = d3.geoPath().projection(projection);

  // All layers live in one group so double-tap zoom can transform them together.
  zoomTransform = { k: 1, x: 0, y: 0 };
  zoomGroup = svg.append('g').attr('class', 'zoom-group');

  // Layer order: modern fill → 1939 border on top → pins → labels
  const layerModern = zoomGroup.append('g').attr('class', 'layer-modern');
  const layerBorder = zoomGroup.append('g').attr('class', 'layer-border-1939');
  const layerPins   = zoomGroup.append('g').attr('class', 'layer-pins');
  const layerLabels = zoomGroup.append('g').attr('class', 'layer-labels');
  const layerHits   = zoomGroup.append('g').attr('class', 'layer-hits');
  layerUserLocation = zoomGroup.append('g').attr('class', 'layer-user-location');

  // Double-tap (double-click) toggles zoom: in on the tapped point, back out if
  // already zoomed. Prevent the browser's default double-click text selection.
  svg.on('dblclick', (event) => {
    event.preventDefault();
    const [x, y] = d3.pointer(event);
    if (zoomTransform.k > 1) resetZoom();
    else zoomToPoint(x, y);
  });

  // While zoomed in, click-and-drag pans the map. The filter restricts dragging
  // to the zoomed state (k > 1) so single-tap clicks and double-tap zoom still
  // behave normally at full view. Updates are applied without a transition for a
  // responsive 1:1 feel, and clamped so the map can't be dragged off-screen.
  let pinching = false;
  let pinchStart = { dist: 1, k: 1 };

  svg.call(d3.drag()
    .filter((event) => zoomTransform.k > 1 && !event.button && !pinching)
    .on('drag', (event) => {
      const { x, y } = clampPan(
        zoomTransform.k,
        zoomTransform.x + event.dx,
        zoomTransform.y + event.dy,
      );
      applyZoom(zoomTransform.k, x, y, false);
    }));

  // Pinch-to-zoom (touch). Keeps the midpoint of the two fingers stationary
  // while scaling, using the standard formula: tx_new = cx*(1 - kRatio) + tx*kRatio.
  const svgNode = svg.node();
  svgNode.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      pinching = true;
      pinchStart.dist = Math.hypot(
        event.touches[0].clientX - event.touches[1].clientX,
        event.touches[0].clientY - event.touches[1].clientY,
      );
      pinchStart.k = zoomTransform.k;
    }
  }, { passive: true });

  svgNode.addEventListener('touchmove', (event) => {
    if (!pinching || event.touches.length !== 2) return;
    const dist = Math.hypot(
      event.touches[0].clientX - event.touches[1].clientX,
      event.touches[0].clientY - event.touches[1].clientY,
    );
    const newK = Math.max(1, Math.min(ZOOM_FACTOR, pinchStart.k * (dist / pinchStart.dist)));
    const cx = (event.touches[0].clientX + event.touches[1].clientX) / 2;
    const cy = (event.touches[0].clientY + event.touches[1].clientY) / 2;
    const kRatio = newK / zoomTransform.k;
    const { x, y } = clampPan(
      newK,
      cx * (1 - kRatio) + zoomTransform.x * kRatio,
      cy * (1 - kRatio) + zoomTransform.y * kRatio,
    );
    applyZoom(newK, x, y, false);
  }, { passive: true });

  svgNode.addEventListener('touchend', () => { pinching = false; }, { passive: true });

  // Load all data in parallel
  Promise.all([
    d3.json('data/poland_modern.geojson'),
    d3.json('data/poland_1939.geojson'),
    d3.json('data/cities.json'),
    d3.json('data/content.json'),
  ]).then(([modern, border1939, cities, content]) => {
    document.getElementById('map-loading')?.remove();
    modernGeo = modern;
    border1939Geo = border1939;
    citiesData = cities;
    contentData = content || [];
    contentByCity = {};
    contentData.forEach((item) => {
      (item.places || []).forEach((placeId) => {
        if (!contentByCity[placeId]) contentByCity[placeId] = [];
        contentByCity[placeId].push(item);
      });
    });

    // Draw 1939 border (dashed underlay)
    layerBorder.selectAll('path')
      .data(border1939.features)
      .enter().append('path')
      .attr('d', path)
      .attr('class', 'border-1939');

    // Draw modern Poland
    layerModern.selectAll('path')
      .data(modern.features)
      .enter().append('path')
      .attr('d', path)
      .attr('class', 'modern-border');

    // Camp pins are drawn larger (r=3 vs r=2) than every other type, so where
    // a camp sits right next to another city (e.g. Majdanek next to Lublin)
    // its bigger circle can fully cover the smaller one if painted on top.
    // SVG paints in document order, so draw camps first (bottom) and
    // everything else after (top) — same array, just reordered for z-index,
    // `cities`/`citiesData` itself stays in its original order for every
    // other consumer (search, nearest, etc).
    const citiesByZOrder = [...cities].sort((a, b) => (a.type === 'camp' ? 0 : 1) - (b.type === 'camp' ? 0 : 1));

    // Draw city pins
    layerPins.selectAll('circle')
      .data(citiesByZOrder)
      .enter().append('circle')
      .attr('class', 'city-pin')
      .attr('cx', d => projection([d.lng, d.lat])[0])
      .attr('cy', d => projection([d.lng, d.lat])[1])
      .attr('r', pinRadius)
      .attr('fill', d => PIN_COLORS[d.type] || '#999')
      .attr('id', d => `pin-${d.id}`)
      .on('click', (event, d) => {
        event.stopPropagation();
        openCityPanel(d);
      });

    // Draw city labels — placed to avoid overlapping other labels/pins.
    // See placeCityLabels() below for the algorithm.
    const placedLabels = placeCityLabels(cities, projection, modern, border1939, width, height);

    layerLabels.selectAll('text')
      .data(placedLabels)
      .enter().append('text')
      .attr('class', 'city-label')
      .attr('x', d => d.labelX)
      .attr('y', d => d.labelY)
      .attr('text-anchor', d => d.anchor)
      .attr('dominant-baseline', 'middle')
      .text(d => d.name);

    // Invisible hit areas — 10px radius gives a ~20px tap target on top of the 2–3px pin.
    // Same z-order as the pins themselves, so a tap near two overlapping
    // cities' hit areas hits whichever one is visually on top.
    layerHits.selectAll('circle')
      .data(citiesByZOrder)
      .enter().append('circle')
      .attr('cx', d => projection([d.lng, d.lat])[0])
      .attr('cy', d => projection([d.lng, d.lat])[1])
      .attr('r', 10)
      .attr('fill', 'transparent')
      .on('click', (event, d) => {
        event.stopPropagation();
        openCityPanel(d);
      });

    // Re-place the "you are here" dot if location sharing was already on
    // (e.g. after a resize tore down and rebuilt the whole map — the
    // interval from startLocationWatch() is still running in that case).
    renderUserLocationDot();

    // Fresh app launch with sharing left on from a previous session:
    // locationWatchId is null here (nothing running yet), unlike the resize
    // case above. Resumes location silently (no fresh gesture needed for
    // its permission prompt); the compass heading cone can't auto-resume
    // the same way, so it stays off until the toggle is flipped again.
    if (locationWatchId === null && getShareLocationSetting()) {
      requestUserLocation()
        .then((loc) => {
          userLocation = loc;
          startLocationWatch();
          renderUserLocationDot();
        })
        .catch((err) => {
          console.error('Failed to resume location sharing:', err);
          setShareLocationSetting(false);
        });
    }

  }).catch(err => {
    document.getElementById('map-loading')?.remove();
    console.error('Failed to load data:', err);
  });

  // Close panel when clicking the map overlay
  document.getElementById('map-overlay').addEventListener('click', () => {
    closePanel();
    closeNearestPanel();
    closeAccountPanel();
    closeSearchPanel();
  });

  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.getElementById('panel-back').addEventListener('click', () => {
    if (panelState.detailItem !== null) {
      // Detail → this city's list first, same as before.
      panelState.detailItem = null;
      renderPanelList();
      updatePanelBackVisibility();
      document.getElementById('panel-title').textContent = getPanelListTitle();
    } else if (panelReturnTo !== null) {
      // Already at list level: close this city panel and reopen whichever
      // menu it was opened from.
      const { onBack } = panelReturnTo;
      panelReturnTo = null;
      closePanel();
      onBack();
    }
  });

  // Nearest-places feature
  document.getElementById('find-nearest-btn').addEventListener('click', enterSelectMode);
  document.getElementById('cancel-select-mode').addEventListener('click', (e) => {
    e.stopPropagation();
    exitSelectMode();
  });
  document.getElementById('close-nearest').addEventListener('click', closeNearestPanel);
  // Capture phase so a click in select mode is handled before pin/overlay handlers.
  document.getElementById('map').addEventListener('click', handleMapSelectClick, true);

  // Account panel
  document.getElementById('account-btn').addEventListener('click', openAccountPanel);
  document.getElementById('close-account').addEventListener('click', closeAccountPanel);

  // Settings panel (opens on top of the account panel)
  document.getElementById('settings-back').addEventListener('click', closeSettingsPanel);

  // All Content
  document.getElementById('all-content-btn').addEventListener('click', openLibrary);

  // Re-render account UI whenever auth/marks change.
  if (window.Account) {
    Account.onChange(() => {
      if (document.getElementById('account-panel').classList.contains('visible')) {
        renderAccountPanel();
      }
    });
  }

  // Swipe-to-dismiss for mobile bottom sheets.
  makeSwipeable(document.getElementById('panel'), closePanel);
  makeSwipeable(document.getElementById('account-panel'), closeAccountPanel);
  makeSwipeable(document.getElementById('settings-panel'), closeSettingsPanel);
  makeSwipeable(document.getElementById('nearest-panel'), closeNearestPanel);
  makeSwipeable(document.getElementById('search-panel'), closeSearchPanel);

  // Search
  document.getElementById('search-btn').addEventListener('click', openSearchPanel);
  document.getElementById('close-search').addEventListener('click', closeSearchPanel);
  document.getElementById('search-input').addEventListener('input', (e) => {
    renderSearchList(e.target.value);
  });

}

// ---- Unified panel ----

// returnTo: { onBack: () => void } | null — set when opened from another
// menu (Nearest Places, Find a City, a saved video in Account) so the back
// arrow can return there instead of just closing. Left null for direct
// map-pin clicks.
function openCityPanel(city, returnTo = null) {
  closeAccountPanel();
  if (activePinId) {
    const prev = document.getElementById(`pin-${activePinId}`);
    if (prev) prev.classList.remove('active');
  }
  activePinId = city.id;
  const pin = document.getElementById(`pin-${city.id}`);
  if (pin) pin.classList.add('active');

  panelState = { open: true, cityId: city.id, detailItem: null, items: null };
  panelReturnTo = returnTo;
  document.getElementById('panel-title').textContent = city.name;
  updatePanelBackVisibility();
  renderPanelList();
  document.getElementById('panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function openLibrary() {
  closeAccountPanel();
  if (activePinId) {
    const prev = document.getElementById(`pin-${activePinId}`);
    if (prev) prev.classList.remove('active');
    activePinId = null;
  }
  panelState = { open: true, cityId: null, detailItem: null, items: null };
  panelReturnTo = null;
  document.getElementById('panel-title').textContent = 'All Content';
  updatePanelBackVisibility();
  renderPanelList();
  document.getElementById('panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closePanel() {
  panelState = { open: false, cityId: null, detailItem: null, items: null };
  panelReturnTo = null;
  document.getElementById('panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');
  if (activePinId) {
    const pin = document.getElementById(`pin-${activePinId}`);
    if (pin) pin.classList.remove('active');
    activePinId = null;
  }
}

function renderPanelList() {
  const listEl = document.getElementById('panel-list');
  const detailEl = document.getElementById('panel-detail');
  listEl.innerHTML = '';
  listEl.classList.remove('hidden');
  detailEl.classList.add('hidden');

  // Computed once per panel-open and cached on panelState, so navigating
  // back from a detail view re-renders the exact same list (same shuffle)
  // instead of recomputing — see openCityPanel/openLibrary.
  if (!panelState.items) {
    if (panelState.cityId) {
      panelState.items = [...(contentByCity[panelState.cityId] || [])].sort((a, b) =>
        CONTENT_TYPE_ORDER.indexOf(a.content_type) - CONTENT_TYPE_ORDER.indexOf(b.content_type)
      );
    } else {
      panelState.items = [...contentData].sort(() => Math.random() - 0.5);
    }
  }
  const items = panelState.items;

  if (items.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No content for this city yet.</div>';
    return;
  }

  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'panel-list-item';
    btn.addEventListener('click', () => renderPanelDetail(item));

    if (item.youtube_id) {
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'panel-item-thumb-wrap';

      const thumb = document.createElement('img');
      thumb.className = 'panel-item-thumb';
      thumb.src = `https://img.youtube.com/vi/${item.youtube_id}/mqdefault.jpg`;
      thumb.alt = '';
      thumbWrap.appendChild(thumb);

      if (item.runtime) {
        const duration = document.createElement('span');
        duration.className = 'panel-item-duration';
        duration.textContent = item.runtime;
        thumbWrap.appendChild(duration);
      }

      btn.appendChild(thumbWrap);
    } else {
      const icon = document.createElement('div');
      icon.className = 'panel-item-thumb panel-item-article-icon';
      icon.textContent = '📖';
      btn.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'panel-item-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'panel-item-title';
    titleEl.textContent = item.title || 'Untitled';
    info.appendChild(titleEl);

    const metaParts = [];
    if (item.author) metaParts.push(item.author);
    if (CONTENT_TYPE_LABELS[item.content_type]) metaParts.push(CONTENT_TYPE_LABELS[item.content_type]);
    if (!panelState.cityId && item.places && item.places.length) {
      const names = item.places.map(id => {
        const c = citiesData.find(x => x.id === id);
        return c ? c.name : id;
      }).join(', ');
      metaParts.push(names);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'panel-item-meta';
    metaEl.textContent = metaParts.join(' · ');
    info.appendChild(metaEl);

    btn.appendChild(info);
    listEl.appendChild(btn);
  });

  truncateTitlesToFit(listEl);
}

// CSS text-overflow: ellipsis cuts off mid-word ("...Jewi..."), which reads
// badly for titles. Since the ellipsis point depends on the rendered pixel
// width of each title (font, panel width, mobile vs. desktop), it can't be
// done with a fixed character count in a static site with no build step —
// measure with canvas (cheap, no layout thrashing) and only cut at a word
// boundary, falling back to a mid-word cut only for a single word too wide
// to fit on its own.
function truncateTitlesToFit(container, selector = '.panel-item-title') {
  const titleEls = Array.from(container.querySelectorAll(selector));
  if (!titleEls.length) return;

  const style = getComputedStyle(titleEls[0]);
  const canvas = truncateTitlesToFit._canvas || (truncateTitlesToFit._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  // Read every available width up front so it's one batched layout pass,
  // not one forced reflow per title.
  const widths = titleEls.map((el) => el.clientWidth);

  titleEls.forEach((el, i) => {
    const full = el.textContent;
    const maxWidth = widths[i];
    if (!maxWidth || ctx.measureText(full).width <= maxWidth) return;

    const words = full.split(' ');
    while (words.length > 1) {
      words.pop();
      if (ctx.measureText(words.join(' ') + '…').width <= maxWidth) break;
    }

    let truncated = words.join(' ');
    if (words.length === 1) {
      while (truncated.length > 1 && ctx.measureText(truncated + '…').width > maxWidth) {
        truncated = truncated.slice(0, -1);
      }
    }
    el.textContent = truncated + '…';
  });
}

function renderPanelDetail(item) {
  panelState.detailItem = item;

  const listEl = document.getElementById('panel-list');
  const detailEl = document.getElementById('panel-detail');
  const detailBody = document.getElementById('panel-detail-body');

  listEl.classList.add('hidden');
  detailEl.classList.remove('hidden');
  document.getElementById('panel-back').classList.remove('hidden');
  document.getElementById('panel-title').textContent = item.title || 'Untitled';
  detailEl.scrollTop = 0;
  detailBody.innerHTML = '';

  if (item.content_type === 'article') {
    const article = document.createElement('div');
    article.className = 'panel-article';
    article.innerHTML = item.body || '<p>Content coming soon.</p>';
    detailBody.appendChild(article);
  } else if (item.youtube_id) {
    const wrapper = document.createElement('div');
    wrapper.className = 'video-item';

    // The native app's local content never gets a real https origin —
    // Capacitor's iOS bridge only accepts a truly custom scheme for
    // iosScheme, silently rejecting "https" and falling back to
    // "capacitor://" — and YouTube's embed player rejects that origin
    // outright (Error 153). youtube-embed.html is a real page fetched over
    // the network from the live site, so it has a real origin YouTube
    // accepts; the app embeds that instead of embedding YouTube directly.
    // The website itself already has a real origin, so it embeds YouTube
    // as normal.
    // autoplay=1 here is what turns the facade's click into "starts
    // playing" instead of "loads YouTube's own paused thumbnail, which
    // then needs a second tap." It's only reachable through this click
    // handler, so it's always a direct result of a real user gesture —
    // exactly the condition WebKit's autoplay-with-sound policy requires.
    const embedSrc = isNativeApp
      ? `${LIVE_SITE_ORIGIN}/youtube-embed.html?v=${encodeURIComponent(item.youtube_id)}`
      : `https://www.youtube-nocookie.com/embed/${item.youtube_id}` +
        `?playsinline=1&autoplay=1&origin=${encodeURIComponent(window.location.origin)}`;

    const facade = document.createElement('div');
    facade.className = 'video-facade';
    facade.innerHTML = `<img class="video-thumb" src="https://img.youtube.com/vi/${item.youtube_id}/hqdefault.jpg" alt="${item.title || 'YouTube video'}"><div class="play-overlay"><div class="play-btn">&#9654;</div></div>`;
    facade.addEventListener('click', () => {
      // Built via createElement + property assignment rather than an
      // innerHTML string — some WebKit versions don't reliably apply
      // referrerpolicy (and other attributes) to iframes injected via
      // innerHTML, silently dropping the referrer YouTube's embed
      // validation needs regardless of what origin/embed URL is correct.
      const iframe = document.createElement('iframe');
      iframe.width = '560';
      iframe.height = '315';
      iframe.src = embedSrc;
      iframe.title = item.title || 'YouTube video';
      iframe.frameBorder = '0';
      // Permissions must be explicitly delegated through the app's proxy
      // page too, or the nested YouTube iframe inside it won't inherit them.
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.allowFullscreen = true;
      wrapper.replaceChild(iframe, facade);
    });
    wrapper.appendChild(facade);

    if (item.title || item.author || item.runtime) {
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      if (item.title) {
        const t = document.createElement('div');
        t.className = 'video-title';
        t.textContent = item.title;
        meta.appendChild(t);
      }
      const details = [];
      if (item.author) details.push(item.author);
      if (item.runtime) details.push(item.runtime);
      if (details.length) {
        const d = document.createElement('div');
        d.className = 'video-detail';
        d.textContent = details.join(' · ');
        meta.appendChild(d);
      }
      wrapper.appendChild(meta);
    }

    const cityId = (item.places || [])[0];
    if (window.Account) {
      const actions = document.createElement('div');
      actions.className = 'video-actions';
      actions.appendChild(makeMarkButton('starred', item.youtube_id, cityId));
      actions.appendChild(makeMarkButton('watch_later', item.youtube_id, cityId));
      wrapper.appendChild(actions);
    }

    detailBody.appendChild(wrapper);
  }
}

// ---- YouTube helpers ----

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (youtubeAPIReady && window.YT && window.YT.Player) {
      resolve();
      return;
    }

    if (window.YT && window.YT.Player) {
      youtubeAPIReady = true;
      resolve();
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      youtubeAPIReady = true;
      resolve();
    };

    setTimeout(() => {
      youtubeAPIReady = true;
      resolve();
    }, 5000);
  });
}

function extractYouTubeVideoId(url) {
  const match = url.match(/embed\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ---- Mark buttons ----

// Build a toggle button for a video mark ('starred' or 'watch_later').
// The 'starred' (like) button also shows the public like count.
function makeMarkButton(kind, ytId, cityId) {
  const isLike = kind === 'starred';
  const meta = isLike
    ? { icon: '♥', label: 'Like' }
    : { icon: '◷', label: 'Watch later' };

  const btn = document.createElement('button');
  btn.className = 'mark-btn';
  btn.dataset.kind = kind;

  function labelText() {
    if (!isLike) return meta.label;
    const count = window.Account ? Account.getLikeCount(ytId) : 0;
    return count > 0 ? `${meta.label} · ${count}` : meta.label;
  }

  btn.innerHTML = `<span class="mark-icon">${meta.icon}</span><span class="mark-label">${labelText()}</span>`;

  const signedIn = window.Account && Account.getUser();
  if (signedIn && Account.isMarked(kind, ytId)) btn.classList.add('marked');

  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!window.Account || !Account.getUser()) {
      openAccountPanel();
      return;
    }
    try {
      const nowMarked = await Account.toggleMark(kind, ytId, cityId);
      btn.classList.toggle('marked', nowMarked);
      if (isLike) btn.querySelector('.mark-label').textContent = labelText();
    } catch (err) {
      console.error('Failed to toggle mark:', err);
    }
  });

  return btn;
}

// ---- Account panel ----

function openAccountPanel() {
  renderAccountPanel();
  document.getElementById('account-panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closeAccountPanel() {
  document.getElementById('account-panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');
  closeSettingsPanel();
}

// ---- Settings (opens on top of the account panel) ----

const SETTINGS_SHARE_LOCATION_KEY = 'settings.shareLocation';

function getShareLocationSetting() {
  return localStorage.getItem(SETTINGS_SHARE_LOCATION_KEY) === 'true';
}

function setShareLocationSetting(enabled) {
  localStorage.setItem(SETTINGS_SHARE_LOCATION_KEY, String(enabled));
}

// userLocation is declared near the other map-scope state above (it feeds
// the "you are here" dot); not persisted across reloads — re-fetched
// whenever the toggle is turned on.

const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

// Resolves to { lat, lng } or throws if permission is denied/unavailable.
// Uses the native Geolocation plugin in the app (consistent permission
// prompt + Info.plist usage string); falls back to the standard browser
// API on the plain website.
async function requestUserLocation() {
  // maximumAge: 0 forces a fresh fix on every call instead of an OS-cached
  // one — this function is polled repeatedly by startLocationWatch(), so a
  // cached reading would make the map dot look stuck.
  if (isNativeApp) {
    const Geolocation = window.Capacitor.Plugins.Geolocation;
    const perm = await Geolocation.requestPermissions();
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      throw new Error('Location permission denied');
    }
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0 });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  }

  if (!navigator.geolocation) throw new Error('Geolocation is not supported on this browser.');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  });
}

function isWithinPolandBorders(lat, lng) {
  if (!modernGeo && !border1939Geo) return false;
  const point = [lng, lat]; // GeoJSON/d3-geo order: [longitude, latitude]
  return (!!modernGeo && d3.geoContains(modernGeo, point)) ||
         (!!border1939Geo && d3.geoContains(border1939Geo, point));
}

// Draws/updates the "you are here" dot + heading cone. Only shown while
// location sharing is on AND the fix falls within Poland's modern or 1939
// borders. Reuses the existing marker's DOM node across updates (position
// and heading can both change many times a second) instead of tearing it
// down each call.
function renderUserLocationDot() {
  if (!layerUserLocation) return;

  const visible = !!(projection && userLocation && isWithinPolandBorders(userLocation.lat, userLocation.lng));

  if (!visible) {
    layerUserLocation.selectAll('*').remove();
    return;
  }

  const [x, y] = projection([userLocation.lng, userLocation.lat]);

  let marker = layerUserLocation.select('.user-location-marker');
  let scaleGroup;
  if (marker.empty()) {
    marker = layerUserLocation.append('g').attr('class', 'user-location-marker');
    // Nested group counters zoomGroup's scale so the dot stays a constant
    // on-screen size instead of growing huge when zoomed in (like the city
    // pins do — fine for their 2-3px radius, not fine at this size).
    scaleGroup = marker.append('g').attr('class', 'user-location-scale');
    scaleGroup.append('circle').attr('class', 'user-location-pulse').attr('r', 14);
    scaleGroup.append('path').attr('class', 'user-location-cone').attr('d', USER_LOCATION_CONE_PATH);
    scaleGroup.append('circle').attr('class', 'user-location-dot').attr('r', USER_LOCATION_DOT_R);
  } else {
    scaleGroup = marker.select('.user-location-scale');
  }
  marker.attr('transform', `translate(${x}, ${y})`);
  scaleGroup.attr('transform', `scale(${userLocationScaleFactor()})`);

  const cone = marker.select('.user-location-cone');
  if (userHeading !== null) {
    cone.style('display', null).attr('transform', `rotate(${userHeading})`);
  } else {
    cone.style('display', 'none');
  }
}

// Continuous position updates while sharing is on. The native Geolocation
// plugin's watchPosition() needs its own JS wrapper to handle the repeating
// callback correctly (we call the raw window.Capacitor.Plugins proxy
// directly, without a bundler, and that raw proxy only supports one-shot
// Promise calls) — so instead of watchPosition/clearWatch, this just polls
// the already-working getCurrentPosition() on an interval. Simpler, and
// imperceptibly different for a walking-pace map dot.
const LOCATION_POLL_INTERVAL_MS = 6000;

function startLocationWatch() {
  stopLocationWatch();
  locationWatchId = setInterval(async () => {
    try {
      userLocation = await requestUserLocation();
      renderUserLocationDot();
      refreshShareLocationStatus();
    } catch (err) {
      console.error('Location watch error:', err);
    }
  }, LOCATION_POLL_INTERVAL_MS);
}

function stopLocationWatch() {
  if (locationWatchId === null) return;
  clearInterval(locationWatchId);
  locationWatchId = null;
}

// True compass heading (not just GPS travel direction), via WebKit's
// deviceorientation extension. Requires an explicit permission prompt on
// iOS 13+, which must be triggered by a user gesture — called from the
// Settings toggle's own click handler, so that requirement is satisfied.
// Not simulatable in the iOS Simulator (no virtual magnetometer); the cone
// simply won't appear there even once permission is granted.
function handleOrientationEvent(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === 'number') {
    heading = event.webkitCompassHeading; // iOS: already true-north-relative
  } else if (event.absolute && typeof event.alpha === 'number') {
    heading = 360 - event.alpha; // best-effort fallback for other browsers
  }
  if (heading === null || Number.isNaN(heading)) return;
  userHeading = (heading + 360) % 360;
  renderUserLocationDot();
}

async function startCompassWatch() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') return;
    } catch (err) {
      console.error('Compass permission request failed:', err);
      return;
    }
  }
  window.addEventListener('deviceorientation', handleOrientationEvent);
  compassListenerActive = true;
}

function stopCompassWatch() {
  if (!compassListenerActive) return;
  window.removeEventListener('deviceorientation', handleOrientationEvent);
  compassListenerActive = false;
  userHeading = null;
}

function openSettingsPanel() {
  renderSettingsPanel();
  document.getElementById('settings-panel').classList.add('visible');
}

function closeSettingsPanel() {
  document.getElementById('settings-panel').classList.remove('visible');
}

// Live status line, shared between the initial render and every poll tick
// so reopening Settings (or just leaving it open) always shows the
// currently-tracked position, not a stale snapshot from when it was
// first toggled on.
function shareLocationStatusText() {
  if (userLocation === null || locationWatchId === null) return 'Off';
  return `On — current location (${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}).`;
}

function refreshShareLocationStatus() {
  const status = document.getElementById('share-location-status');
  if (status) status.textContent = shareLocationStatusText();
}

function renderSettingsPanel() {
  const body = document.getElementById('settings-body');
  // Reflect whether tracking is actually running right now, not just the
  // last-saved preference — compass heading can't auto-resume across
  // reloads (its permission prompt needs a fresh user gesture on iOS),
  // though location itself now does (see startLocationWatch() call in init).
  const enabled = userLocation !== null && locationWatchId !== null;

  body.innerHTML =
    '<div class="settings-row">' +
    '<div class="settings-row-text">' +
    '<div class="settings-row-label">Share Your Location</div>' +
    `<div class="settings-row-desc" id="share-location-status">${shareLocationStatusText()}</div>` +
    '</div>' +
    '<label class="toggle-switch">' +
    `<input type="checkbox" id="share-location-toggle" ${enabled ? 'checked' : ''}>` +
    '<span class="toggle-slider"></span>' +
    '</label>' +
    '</div>';

  const toggle = document.getElementById('share-location-toggle');
  const status = document.getElementById('share-location-status');

  toggle.addEventListener('change', async (e) => {
    const checked = e.target.checked;

    if (!checked) {
      setShareLocationSetting(false);
      stopLocationWatch();
      stopCompassWatch();
      userLocation = null;
      renderUserLocationDot();
      status.textContent = 'Off';
      return;
    }

    status.textContent = 'Requesting location…';
    try {
      userLocation = await requestUserLocation();
      setShareLocationSetting(true);
      startLocationWatch();
      renderUserLocationDot();
      refreshShareLocationStatus();
      // Separate permission prompt (compass); location sharing still works
      // without it, just without a heading cone.
      startCompassWatch();
    } catch (err) {
      console.error('Location request failed:', err);
      toggle.checked = false;
      setShareLocationSetting(false);
      const detail = (err && err.message) || String(err);
      status.textContent = `Could not get your location: ${detail}`;
    }
  });
}

let accountActiveKind = 'starred';

function renderAccountPanel() {
  const body = document.getElementById('account-body');

  if (!window.Account) {
    body.innerHTML = '<div class="empty-state">Accounts are unavailable right now.</div>';
    return;
  }

  const user = Account.getUser();

  if (!user) {
    body.innerHTML =
      '<div class="account-signin">' +
      '<p class="account-signin-msg">Sign in to like videos and build your watch-later list.</p>' +
      '<button id="google-signin-btn" class="google-btn">' +
      '<svg class="google-icon" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">' +
      '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
      '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
      '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
      '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
      '</svg><span>Sign in with Google</span></button>' +
      '</div>';
    document.getElementById('google-signin-btn')
      .addEventListener('click', () => Account.signInWithGoogle());
    return;
  }

  body.innerHTML =
    '<div class="account-user">' +
    `<div class="account-email">${user.email || 'Signed in'}</div>` +
    '<button id="signout-btn" class="account-link-btn">Sign out</button>' +
    '</div>' +
    '<button id="settings-btn" class="account-settings-btn">' +
    '<span>Settings</span><span class="chevron">›</span>' +
    '</button>' +
    '<div id="account-list-view"></div>' +
    '<div class="account-lists">' +
    `<button class="account-list-btn ${accountActiveKind === 'starred' ? 'active' : ''}" data-kind="starred">♥ Liked</button>` +
    `<button class="account-list-btn ${accountActiveKind === 'watch_later' ? 'active' : ''}" data-kind="watch_later">◷ Watch Later</button>` +
    '</div>';

  document.getElementById('signout-btn')
    .addEventListener('click', () => Account.signOut());

  document.getElementById('settings-btn')
    .addEventListener('click', openSettingsPanel);

  document.querySelectorAll('.account-list-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      accountActiveKind = btn.dataset.kind;
      renderAccountPanel();
    });
  });

  renderAccountList(accountActiveKind);
}

function renderAccountList(kind) {
  const view = document.getElementById('account-list-view');
  if (!view) return;

  const marks = Account.getMarks(kind);
  if (marks.length === 0) {
    const msg = kind === 'starred'
      ? 'No liked videos yet. Tap ♥ on any video to like it.'
      : 'Nothing saved yet. Tap ◷ on any video to watch it later.';
    view.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  view.innerHTML = '';
  marks.forEach((mark) => {
    const city = citiesData.find((c) => c.id === mark.city_id);
    const contentItem = contentData.find((c) => c.youtube_id === mark.youtube_id);
    const btn = document.createElement('button');
    btn.className = 'account-video-item';
    const title = (contentItem && contentItem.title) || 'Untitled';
    const durationBadge = contentItem && contentItem.runtime
      ? `<span class="panel-item-duration">${contentItem.runtime}</span>`
      : '';

    btn.innerHTML =
      `<span class="account-video-thumb-wrap">` +
        `<img class="account-video-thumb" src="https://img.youtube.com/vi/${mark.youtube_id}/mqdefault.jpg" alt="">` +
        durationBadge +
      `</span>` +
      '<span class="account-video-info">' +
      `<span class="account-video-title">${title}</span>` +
      `<span class="account-video-meta">${city ? city.name : mark.city_id}</span>` +
      '</span>';
    btn.addEventListener('click', () => openAccountVideo(mark.city_id, mark.youtube_id));
    view.appendChild(btn);
  });

  truncateTitlesToFit(view, '.account-video-title');
}

function openAccountVideo(cityId, ytId) {
  const city = citiesData.find((c) => c.id === cityId);
  if (!city) return;
  closeAccountPanel();
  openCityPanel(city, { onBack: () => openAccountPanel() });
  const contentItem = (contentByCity[cityId] || []).find((c) => c.youtube_id === ytId);
  if (contentItem) renderPanelDetail(contentItem);
}

// ---- Double-tap zoom ----

function zoomToPoint(x, y) {
  if (!zoomGroup) return;
  const { width, height } = getMapDimensions();
  const k = ZOOM_FACTOR;
  const { x: tx, y: ty } = clampPan(k, width / 2 - k * x, height / 2 - k * y);
  applyZoom(k, tx, ty);
}

function resetZoom() {
  applyZoom(1, 0, 0);
}

function applyZoom(k, x, y, animate = true) {
  zoomTransform = { k, x, y };
  document.body.classList.toggle('map-zoomed', k > 1);
  const target = animate
    ? zoomGroup.transition().duration(600).ease(d3.easeCubicInOut)
    : zoomGroup.interrupt();
  target.attr('transform', `translate(${x}, ${y}) scale(${k})`);

  // Keep the "you are here" dot from either ballooning or shrinking below
  // pin size as zoom changes.
  if (layerUserLocation) {
    const scaleGroup = layerUserLocation.select('.user-location-scale');
    if (!scaleGroup.empty()) scaleGroup.attr('transform', `scale(${userLocationScaleFactor()})`);
  }
}

function clampPan(k, x, y) {
  const { width, height } = getMapDimensions();
  return {
    x: Math.max(width * (1 - k), Math.min(0, x)),
    y: Math.max(height * (1 - k), Math.min(0, y)),
  };
}

// ---- Nearest places ----

function enterSelectMode() {
  // Already waiting for a map click (location sharing is off)? Clicking
  // Find Nearest again cancels it instead of starting over.
  if (selectMode) {
    exitSelectMode();
    return;
  }

  closePanel();
  closeNearestPanel();

  // Already sharing a live location? Skip click-to-place and use it directly.
  if (userLocation !== null) {
    const results = getNearestPlaces(userLocation.lat, userLocation.lng, 5);
    openNearestPanel(results, true);
    return;
  }

  selectMode = true;
  document.body.classList.add('select-mode');
}

function exitSelectMode() {
  selectMode = false;
  document.body.classList.remove('select-mode');
}

function handleMapSelectClick(event) {
  if (!selectMode || !projection) return;
  event.preventDefault();
  event.stopPropagation();

  const svg = document.querySelector('#map svg');
  const rect = svg.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const mapX = (x - zoomTransform.x) / zoomTransform.k;
  const mapY = (y - zoomTransform.y) / zoomTransform.k;
  const [lng, lat] = projection.invert([mapX, mapY]);

  exitSelectMode();
  const results = getNearestPlaces(lat, lng, 5);
  openNearestPanel(results);
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getNearestPlaces(lat, lng, n = 5) {
  return citiesData
    .filter((c) => c.lat != null && c.lng != null)
    .map((c) => ({ ...c, distanceKm: haversineKm(lat, lng, c.lat, c.lng) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

function openNearestPanel(results, fromLiveLocation = false) {
  const list = document.getElementById('nearest-list');
  list.innerHTML = '';

  const anchor = fromLiveLocation ? 'your location' : 'your point';
  document.getElementById('nearest-subtitle').textContent =
    `${results.length} closest ${results.length === 1 ? 'place' : 'places'} to ${anchor}`;

  results.forEach((c) => {
    const km = Math.round(c.distanceKm);
    const mi = Math.round(c.distanceKm * 0.621371);
    const li = document.createElement('li');
    li.className = 'nearest-item';
    li.innerHTML =
      `<span class="dot ${c.type}"></span>` +
      `<span class="nearest-name">${c.name}</span>` +
      `<span class="nearest-dist">${km} km / ${mi} mi</span>`;
    li.addEventListener('click', () => {
      closeNearestPanel();
      openCityPanel(c, { onBack: () => openNearestPanel(results, fromLiveLocation) });
    });
    list.appendChild(li);
  });

  document.getElementById('nearest-panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closeNearestPanel() {
  document.getElementById('nearest-panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');
}

// ---- City search ----

function openSearchPanel() {
  renderSearchList('');
  document.getElementById('search-panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
  setTimeout(() => document.getElementById('search-input').focus(), 320);
}

function closeSearchPanel() {
  document.getElementById('search-panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');
  document.getElementById('search-input').value = '';
}

function renderSearchList(query) {
  const list = document.getElementById('search-list');
  const q = query.trim().toLowerCase();

  const results = citiesData
    .filter(c => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'pl'));

  list.innerHTML = '';

  if (results.length === 0) {
    const li = document.createElement('li');
    li.className = 'search-empty';
    li.textContent = 'No cities match your search.';
    list.appendChild(li);
    return;
  }

  results.forEach((city) => {
    const li = document.createElement('li');
    li.className = 'search-item';

    const nameEl = document.createElement('span');
    nameEl.className = 'search-item-name';
    nameEl.innerHTML = q ? highlightMatch(city.name, q) : city.name;

    const typeEl = document.createElement('span');
    typeEl.className = 'search-item-type';
    typeEl.textContent = TYPE_LABELS[city.type] || city.type;

    const dot = document.createElement('span');
    dot.className = `dot ${city.type}`;

    li.appendChild(dot);
    li.appendChild(nameEl);
    li.appendChild(typeEl);
    li.addEventListener('click', () => {
      closeSearchPanel();
      openCityPanel(city, { onBack: () => openSearchPanel() });
    });
    list.appendChild(li);
  });
}

function highlightMatch(name, query) {
  const idx = name.toLowerCase().indexOf(query);
  if (idx === -1) return name;
  return (
    name.slice(0, idx) +
    '<mark>' + name.slice(idx, idx + query.length) + '</mark>' +
    name.slice(idx + query.length)
  );
}

// Collapsible legend — set up once at module level, independent of map data loading
document.querySelector('#legend .legend-label').addEventListener('click', () => {
  document.getElementById('legend').classList.toggle('collapsed');
});

// #panel sizes to its content (mobile) and only needs safe-area top padding
// once it's actually grown to reach the top of the screen — toggle a class
// based on whether it's hit its max-height cap instead of always padding
// for a notch a short sheet isn't anywhere near. Measures offsetHeight
// rather than getBoundingClientRect().top: the latter reflects the sheet's
// CSS transform (it's off-screen via translateY(100%) until .visible is
// added), so while sliding in for the first time it read as "not at the
// top" even for content that fills the whole screen — offsetHeight isn't
// affected by transform, so it's correct regardless of visibility state.
// #panel lives outside #map, so this only needs to run once, not on every
// resize-triggered init().
if (typeof ResizeObserver !== 'undefined') {
  const panelEl = document.getElementById('panel');
  const updatePanelSafeArea = () => {
    const reachesTop = panelEl.offsetHeight >= window.innerHeight - 4;
    panelEl.classList.toggle('panel-reaches-top', reachesTop);
  };
  new ResizeObserver(updatePanelSafeArea).observe(panelEl);
  updatePanelSafeArea();
}

window.addEventListener('resize', () => {
  document.getElementById('map').innerHTML = '';
  init();
});

init();
