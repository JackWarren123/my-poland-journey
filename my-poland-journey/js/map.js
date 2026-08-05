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

// Tab panel state (transient; reset on every city selection)
let panelState = {
  city: null,
  cityId: null,
  activeTab: 'history',
  currentVideoIndex: 0,
  currentSeriesId: null,
  videoWasInteracted: false,
  videoPlayers: {},
  contentIsEmpty: false,
  videosAreEmpty: false,
};

// YouTube IFrame API state
let youtubeAPIReady = false;

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
  // TEMPORARY: quadrilateral connecting the four main extermination camps
  const layerQuad   = zoomGroup.append('g').attr('class', 'layer-quad');
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

    // TEMPORARY: quadrilateral — Chełmno → Treblinka → Majdanek → Auschwitz
    const quadVerts = [
      [19.2016, 52.0594], // Chełmno
      [22.05,   52.6333], // Treblinka
      [22.6014, 51.2189], // Majdanek
      [19.1783, 50.0341], // Auschwitz
    ];
    const quadPoints = quadVerts.map(([lng, lat]) => projection([lng, lat]).join(',')).join(' ');
    layerQuad.append('polygon')
      .attr('points', quadPoints)
      .attr('fill', 'rgba(180, 40, 32, 0.08)')
      .attr('stroke', '#b02820')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '6,4');

    // TEMPORARY: scaled-out version (1.3×) to include Bielsko-Biała, Kraków, Kutno, etc.
    const centLat = 51.4864, centLng = 20.7578;
    const scaledPoints = quadVerts.map(([lng, lat]) => {
      const sLat = centLat + 1.3 * (lat - centLat);
      const sLng = centLng + 1.3 * (lng - centLng);
      return projection([sLng, sLat]).join(',');
    }).join(' ');
    layerQuad.append('polygon')
      .attr('points', scaledPoints)
      .attr('fill', 'none')
      .attr('stroke', '#b02820')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,5')
      .attr('opacity', 0.5);

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

  // Set up tab click handlers
  setupTabHandlers();
}

function isContentEmpty(city) {
  return !city.content || city.content.trim() === '';
}

function areVideosEmpty(city) {
  return !city.testimonials || city.testimonials.length === 0;
}

function setupTabHandlers() {
  const tabButtons = document.querySelectorAll('.tab-button');
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.getAttribute('data-tab');
      switchTab(tab);
    });
  });
}

function switchTab(tabName) {
  panelState.activeTab = tabName;

  const tabButtons = document.querySelectorAll('.tab-button');
  tabButtons.forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('data-tab') === tabName) {
      btn.classList.add('active');
    }
  });

  const tabPanes = document.querySelectorAll('.tab-pane');
  tabPanes.forEach(pane => {
    pane.classList.add('hidden');
    if (pane.id === `tab-${tabName}`) {
      pane.classList.remove('hidden');
    }
  });

  // Render tab content when switching tabs
  if (tabName === 'history') {
    renderHistoryPane();
  } else if (tabName === 'videos') {
    renderVideosPane();
    // Load YouTube API and attach autoplay listeners after videos are rendered
    loadYouTubeAPI().then(() => {
      attachAutoplayListeners();
    });
  }
}

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

    // Load YouTube API script
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    // Set callback for when API is ready
    window.onYouTubeIframeAPIReady = () => {
      youtubeAPIReady = true;
      resolve();
    };

    // Timeout in case API fails to load
    setTimeout(() => {
      youtubeAPIReady = true;
      resolve();
    }, 5000);
  });
}

function attachAutoplayListeners() {
  if (!youtubeAPIReady || !window.YT || !window.YT.Player) {
    console.log('YouTube API not ready, autoplay disabled');
    return;
  }

  const iframes = document.querySelectorAll('#tab-videos iframe');
  const players = {};

  iframes.forEach((iframe, index) => {
    const videoId = extractYouTubeVideoId(iframe.src);
    if (!videoId) return;

    try {
      const player = new YT.Player(iframe, {
        events: {
          onStateChange: (event) => onVideoStateChange(event, index),
          onError: (event) => console.log('YouTube player error:', event),
        },
      });
      players[index] = player;
    } catch (err) {
      console.log('Could not create YouTube player for iframe', index, err);
    }
  });

  panelState.videoPlayers = players;

  // Attach user interaction listeners
  iframes.forEach((iframe, index) => {
    iframe.addEventListener('click', () => {
      panelState.videoWasInteracted = true;
    });
  });
}

function extractYouTubeVideoId(url) {
  const match = url.match(/embed\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function onVideoStateChange(event, videoIndex) {
  // 0 = UNSTARTED, 1 = ENDED, 2 = PLAYING, 3 = PAUSED, 5 = CUED
  if (event.data === 0) {
    // Video unstarted - reset interaction flag
    panelState.videoWasInteracted = false;
  } else if (event.data === 1) {
    // Video ended - advance to next video in series if applicable
    advanceToNextSeriesVideo(videoIndex);
  }
}

function advanceToNextSeriesVideo(currentVideoIndex) {
  // For now, series_id data is not available in the current testimonials format
  // Once series_id is added to the data model, this will advance to the next video
  // with the same series_id
  // Placeholder: no autoplay until series_id data is populated
}

function cleanupVideoPlayers() {
  Object.values(panelState.videoPlayers).forEach(player => {
    try {
      if (player && player.destroy) {
        player.destroy();
      }
    } catch (err) {
      console.log('Error cleaning up video player:', err);
    }
  });
  panelState.videoPlayers = {};
}

function renderHistoryPane() {
  const contentEl = document.getElementById('panel-content');
  contentEl.innerHTML = '';

  if (panelState.contentIsEmpty) {
    contentEl.innerHTML = '<div class="empty-state">No history available yet</div>';
  } else if (panelState.city && panelState.city.content) {
    contentEl.innerHTML = panelState.city.content;
  }
}

function renderVideosPane() {
  const testimonialsEl = document.getElementById('panel-testimonials');
  testimonialsEl.innerHTML = '';

  if (panelState.videosAreEmpty) {
    testimonialsEl.innerHTML = '<div class="empty-state">No videos available yet</div>';
  } else if (panelState.city && panelState.city.testimonials) {
    const testimonials = panelState.city.testimonials;
    testimonials.forEach((item, index) => {
      const iframeHtml = typeof item === 'string' ? item : item.html;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = iframeHtml;
      testimonialsEl.appendChild(wrapper);
    });
  }
}

function openPanel(city) {
  // Initialize panel state for this city
  panelState = {
    city: city,
    cityId: city.id,
    activeTab: 'history',
    currentVideoIndex: 0,
    currentSeriesId: null,
    videoWasInteracted: false,
    videoPlayers: {},
    contentIsEmpty: isContentEmpty(city),
    videosAreEmpty: areVideosEmpty(city),
  };

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

  // Render both tabs (history tab shown, videos tab hidden but pre-rendered)
  switchTab('history');
  renderVideosPane();

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
  // Clean up video players before closing panel
  cleanupVideoPlayers();

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
