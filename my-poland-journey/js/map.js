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

const CONTENT_TYPE_LABELS = {
  short_video: 'Short Video',
  full_testimonial: 'Full Testimonial',
  article: 'Article',
};

const CONTENT_TYPE_ORDER = ['article', 'short_video', 'full_testimonial'];

let activePinId = null;

let panelState = {
  open: false,
  cityId: null,      // null = all content, string = filtered to city
  detailItem: null,  // null = list view, item object = detail view
};

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
    d3.json('data/content.json'),
  ]).then(([modern, border1939, cities, content]) => {
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
        openCityPanel(d);
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
    closeAccountPanel();
  });

  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.getElementById('panel-back').addEventListener('click', () => {
    panelState.detailItem = null;
    renderPanelList();
    document.getElementById('panel-back').classList.add('hidden');
  });

  // Nearest-places feature
  document.getElementById('find-nearest-btn').addEventListener('click', enterSelectMode);
  document.getElementById('close-nearest').addEventListener('click', closeNearestPanel);
  // Capture phase so a click in select mode is handled before pin/overlay handlers.
  document.getElementById('map').addEventListener('click', handleMapSelectClick, true);

  // Account panel
  document.getElementById('account-btn').addEventListener('click', openAccountPanel);
  document.getElementById('close-account').addEventListener('click', closeAccountPanel);

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
}

// ---- Unified panel ----

function openCityPanel(city) {
  closeAccountPanel();
  if (activePinId) {
    const prev = document.getElementById(`pin-${activePinId}`);
    if (prev) prev.classList.remove('active');
  }
  activePinId = city.id;
  const pin = document.getElementById(`pin-${city.id}`);
  if (pin) pin.classList.add('active');

  panelState = { open: true, cityId: city.id, detailItem: null };
  document.getElementById('panel-title').textContent = city.name;
  document.getElementById('panel-back').classList.add('hidden');
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
  panelState = { open: true, cityId: null, detailItem: null };
  document.getElementById('panel-title').textContent = 'All Content';
  document.getElementById('panel-back').classList.add('hidden');
  renderPanelList();
  document.getElementById('panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closePanel() {
  panelState = { open: false, cityId: null, detailItem: null };
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

  let items;
  if (panelState.cityId) {
    items = [...(contentByCity[panelState.cityId] || [])].sort((a, b) =>
      CONTENT_TYPE_ORDER.indexOf(a.content_type) - CONTENT_TYPE_ORDER.indexOf(b.content_type)
    );
  } else {
    const articles = contentData.filter(i => i.content_type === 'article');
    const videos = contentData.filter(i => i.content_type !== 'article').sort(() => Math.random() - 0.5);
    items = [...articles, ...videos];
  }

  if (items.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No content for this city yet.</div>';
    return;
  }

  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'panel-list-item';
    btn.addEventListener('click', () => renderPanelDetail(item));

    if (item.youtube_id) {
      const thumb = document.createElement('img');
      thumb.className = 'panel-item-thumb';
      thumb.src = `https://img.youtube.com/vi/${item.youtube_id}/mqdefault.jpg`;
      thumb.alt = '';
      btn.appendChild(thumb);
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
    metaParts.push(CONTENT_TYPE_LABELS[item.content_type] || item.content_type);
    if (item.runtime) metaParts.push(item.runtime);
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
}

function renderPanelDetail(item) {
  panelState.detailItem = item;

  const listEl = document.getElementById('panel-list');
  const detailEl = document.getElementById('panel-detail');
  const detailBody = document.getElementById('panel-detail-body');

  listEl.classList.add('hidden');
  detailEl.classList.remove('hidden');
  document.getElementById('panel-back').classList.remove('hidden');
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

    const iframeHtml = `<iframe width="560" height="315" src="https://www.youtube.com/embed/${item.youtube_id}" title="${item.title || 'YouTube video'}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;

    const facade = document.createElement('div');
    facade.className = 'video-facade';
    facade.innerHTML = `<img class="video-thumb" src="https://img.youtube.com/vi/${item.youtube_id}/hqdefault.jpg" alt="${item.title || 'YouTube video'}"><div class="play-overlay"><div class="play-btn">&#9654;</div></div>`;
    facade.addEventListener('click', () => {
      const temp = document.createElement('div');
      temp.innerHTML = iframeHtml;
      wrapper.replaceChild(temp.firstChild, facade);
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
    '<div id="account-list-view"></div>' +
    '<div class="account-lists">' +
    `<button class="account-list-btn ${accountActiveKind === 'starred' ? 'active' : ''}" data-kind="starred">♥ Liked</button>` +
    `<button class="account-list-btn ${accountActiveKind === 'watch_later' ? 'active' : ''}" data-kind="watch_later">◷ Watch Later</button>` +
    '</div>';

  document.getElementById('signout-btn')
    .addEventListener('click', () => Account.signOut());

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
    const titleLine = contentItem && contentItem.title
      ? `<span class="account-video-title">${contentItem.title}</span>`
      : '';
    btn.innerHTML =
      `<img class="account-video-thumb" src="https://img.youtube.com/vi/${mark.youtube_id}/mqdefault.jpg" alt="">` +
      `<span class="account-video-city">${city ? city.name : mark.city_id}${titleLine}</span>`;
    btn.addEventListener('click', () => openAccountVideo(mark.city_id, mark.youtube_id));
    view.appendChild(btn);
  });
}

function openAccountVideo(cityId, ytId) {
  const city = citiesData.find((c) => c.id === cityId);
  if (!city) return;
  closeAccountPanel();
  openCityPanel(city);
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
  closePanel();
  closeNearestPanel();
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

window.addEventListener('resize', () => {
  document.getElementById('map').innerHTML = '';
  init();
});

init();
