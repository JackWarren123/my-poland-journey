const PIN_COLORS = {
  community: '#3a7bc8',
  ghetto:    '#c87c10',
  camp:      '#b02820',
  massacre:  '#7b3a9e',
  synagogue: '#1e8a4a',
};

const TYPE_LABELS = {
  community: 'Jewish Community',
  ghetto:    'Ghetto',
  camp:      'Extermination / Concentration Camp',
  massacre:  'Massacre Site',
  synagogue: 'Synagogue',
};

let activePinId = null;

// Lifted to module scope so the nearest-places feature can invert clicks and
// read the city list after init().
let projection = null;
let citiesData = [];
let selectMode = false;

// Double-tap zoom state. The map layers live in `zoomGroup`; `zoomTransform`
// mirrors the group's current transform so click->lat/lng inversion stays correct.
let zoomGroup = null;
let zoomTransform = { k: 1, x: 0, y: 0 };
const ZOOM_FACTOR = 6; // how far a double-tap zooms in

function getMapDimensions() {
  return { width: window.innerWidth, height: window.innerHeight };
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
  svg.call(d3.drag()
    .filter((event) => zoomTransform.k > 1 && !event.button)
    .on('drag', (event) => {
      const { x, y } = clampPan(
        zoomTransform.k,
        zoomTransform.x + event.dx,
        zoomTransform.y + event.dy,
      );
      applyZoom(zoomTransform.k, x, y, false);
    }));

  // Load all data in parallel
  Promise.all([
    d3.json('data/poland_modern.geojson'),
    d3.json('data/poland_1939.geojson'),
    d3.json('data/cities.json'),
  ]).then(([modern, border1939, cities]) => {
    citiesData = cities;

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

    // Draw city pins
    layerPins.selectAll('circle')
      .data(cities)
      .enter().append('circle')
      .attr('class', 'city-pin')
      .attr('cx', d => projection([d.lng, d.lat])[0])
      .attr('cy', d => projection([d.lng, d.lat])[1])
      .attr('r', d => d.type === 'camp' ? 3 : 2)
      .attr('fill', d => PIN_COLORS[d.type] || '#999')
      .attr('id', d => `pin-${d.id}`)
      .on('click', (event, d) => {
        event.stopPropagation();
        openPanel(d);
      });

    // Draw city labels
    layerLabels.selectAll('text')
      .data(cities)
      .enter().append('text')
      .attr('class', 'city-label')
      .attr('x', d => projection([d.lng, d.lat])[0] + 4)
      .attr('y', d => projection([d.lng, d.lat])[1] + 2)
      .text(d => d.name);

  }).catch(err => {
    console.error('Failed to load data:', err);
  });

  // Close panel when clicking the map overlay
  document.getElementById('map-overlay').addEventListener('click', () => {
    closePanel();
    closeNearestPanel();
  });
  document.getElementById('close-panel').addEventListener('click', closePanel);

  // Nearest-places feature
  document.getElementById('find-nearest-btn').addEventListener('click', enterSelectMode);
  document.getElementById('close-nearest').addEventListener('click', closeNearestPanel);
  // Capture phase so a click in select mode is handled before pin/overlay handlers.
  document.getElementById('map').addEventListener('click', handleMapSelectClick, true);
}

function openPanel(city) {
  // Update active pin styling
  if (activePinId) {
    const prev = document.getElementById(`pin-${activePinId}`);
    if (prev) prev.classList.remove('active');
  }
  activePinId = city.id;
  const pin = document.getElementById(`pin-${city.id}`);
  if (pin) pin.classList.add('active');

  // Populate panel content
  const badge = document.getElementById('panel-type-badge');
  badge.textContent = TYPE_LABELS[city.type] || city.type;
  badge.className = `badge-${city.type}`;
  badge.id = 'panel-type-badge';

  document.getElementById('panel-name').textContent = city.name;
  document.getElementById('panel-hebrew').textContent = city.hebrew || '';
  document.getElementById('panel-summary').textContent = city.summary || '';

  const sourceEl = document.getElementById('panel-source');
  sourceEl.textContent = city.source || '';
  if (city.source_url) {
    sourceEl.href = city.source_url;
    sourceEl.style.pointerEvents = 'auto';
  } else {
    sourceEl.removeAttribute('href');
    sourceEl.style.pointerEvents = 'none';
  }

  document.getElementById('info-panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closePanel() {
  document.getElementById('info-panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');

  if (activePinId) {
    const pin = document.getElementById(`pin-${activePinId}`);
    if (pin) pin.classList.remove('active');
    activePinId = null;
  }
}

// ---- Double-tap zoom ----

// Zoom in by ZOOM_FACTOR, centering the tapped point (x, y in svg pixels).
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

// Set the zoom/pan transform. Double-tap zoom animates; drag panning passes
// animate=false so each move applies instantly without queuing transitions.
function applyZoom(k, x, y, animate = true) {
  zoomTransform = { k, x, y };
  document.body.classList.toggle('map-zoomed', k > 1);
  const target = animate
    ? zoomGroup.transition().duration(600).ease(d3.easeCubicInOut)
    : zoomGroup.interrupt();
  target.attr('transform', `translate(${x}, ${y}) scale(${k})`);
}

// Constrain a pan translation so the (full-bleed) map keeps covering the
// viewport at scale k — i.e. translate stays within [width*(1-k), 0] on each axis.
function clampPan(k, x, y) {
  const { width, height } = getMapDimensions();
  return {
    x: Math.max(width * (1 - k), Math.min(0, x)),
    y: Math.max(height * (1 - k), Math.min(0, y)),
  };
}

// ---- Nearest places ----

function enterSelectMode() {
  // Clear any open panels so the map is unobstructed.
  closePanel();
  closeNearestPanel();
  selectMode = true;
  document.body.classList.add('select-mode');
}

function exitSelectMode() {
  selectMode = false;
  document.body.classList.remove('select-mode');
}

// Capture-phase handler on #map. Only acts while in select mode, then converts
// the click's pixel position back to lng/lat via the projection.
function handleMapSelectClick(event) {
  if (!selectMode || !projection) return;
  event.preventDefault();
  event.stopPropagation();

  const svg = document.querySelector('#map svg');
  const rect = svg.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  // Undo the current zoom transform before inverting the projection.
  const mapX = (x - zoomTransform.x) / zoomTransform.k;
  const mapY = (y - zoomTransform.y) / zoomTransform.k;
  const [lng, lat] = projection.invert([mapX, mapY]);

  exitSelectMode();
  const results = getNearestPlaces(lat, lng, 5);
  openNearestPanel(results);
}

// Great-circle distance in km between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius, km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Returns the n nearest cities (that have coordinates) with a `distanceKm` field.
function getNearestPlaces(lat, lng, n = 5) {
  return citiesData
    .filter((c) => c.lat != null && c.lng != null)
    .map((c) => ({ ...c, distanceKm: haversineKm(lat, lng, c.lat, c.lng) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

function openNearestPanel(results) {
  const list = document.getElementById('nearest-list');
  list.innerHTML = '';

  document.getElementById('nearest-subtitle').textContent =
    `${results.length} closest ${results.length === 1 ? 'place' : 'places'} to your point`;

  results.forEach((c) => {
    const km = Math.round(c.distanceKm);
    const mi = Math.round(c.distanceKm * 0.621371);
    const li = document.createElement('li');
    li.className = 'nearest-item';
    li.innerHTML =
      `<span class="dot ${c.type}"></span>` +
      `<span class="nearest-name">${c.name}</span>` +
      `<span class="nearest-dist">${km} km / ${mi} mi</span>`;
    list.appendChild(li);
  });

  document.getElementById('nearest-panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closeNearestPanel() {
  document.getElementById('nearest-panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');
}

// Handle window resize
window.addEventListener('resize', () => {
  document.getElementById('map').innerHTML = '';
  init();
});

init();
