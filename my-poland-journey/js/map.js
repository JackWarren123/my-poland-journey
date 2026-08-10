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
    closeAccountPanel();
    closeContentPanel();
  });
  document.getElementById('close-panel').addEventListener('click', closePanel);

  // Nearest-places feature
  document.getElementById('find-nearest-btn').addEventListener('click', enterSelectMode);
  document.getElementById('close-nearest').addEventListener('click', closeNearestPanel);
  // Capture phase so a click in select mode is handled before pin/overlay handlers.
  document.getElementById('map').addEventListener('click', handleMapSelectClick, true);

  // Account panel
  document.getElementById('account-btn').addEventListener('click', openAccountPanel);
  document.getElementById('close-account').addEventListener('click', closeAccountPanel);

  // All Content panel
  document.getElementById('all-content-btn').addEventListener('click', openContentPanel);
  document.getElementById('close-content').addEventListener('click', closeContentPanel);
  document.getElementById('refresh-content').addEventListener('click', shuffleContentPanel);

  // Re-render account UI + video mark buttons whenever auth/marks change
  // (fires on initial session load and on every sign-in/sign-out).
  if (window.Account) {
    Account.onChange(() => {
      if (document.getElementById('account-panel').classList.contains('visible')) {
        renderAccountPanel();
      }
      if (panelState.city &&
          (panelState.activeTab === 'short-videos' || panelState.activeTab === 'full-testimonials')) {
        renderVideosPane(panelState.activeTab === 'short-videos' ? 'short_video' : 'full_testimonial');
      }
    });
  }

  // Set up tab click handlers
  setupTabHandlers();
}

function isContentEmpty(city) {
  if (!city.content || city.content.trim() === '') {
    return true;
  }
  // Remove HTML tags and comments to check if there's meaningful text
  const textOnly = city.content
    .replace(/<!--[\s\S]*?-->/g, '') // Remove comments
    .replace(/<[^>]*>/g, '') // Remove tags
    .trim();
  return textOnly === '';
}

function areVideosEmpty(city) {
  const items = contentByCity[city.id] || [];
  return !items.some((i) => i.content_type === 'short_video' || i.content_type === 'full_testimonial');
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
  } else if (tabName === 'short-videos') {
    renderVideosPane('short_video');
    loadYouTubeAPI().then(() => {
      attachAutoplayListeners();
    });
  } else if (tabName === 'full-testimonials') {
    renderVideosPane('full_testimonial');
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

  if (!panelState.city || isContentEmpty(panelState.city)) {
    contentEl.innerHTML = '<div class="empty-state">No history available yet</div>';
  } else {
    contentEl.innerHTML = panelState.city.content;
  }
}

function renderVideosPane(contentType = 'short_video') {
  const elementId = contentType === 'short_video' ? 'panel-short-videos' : 'panel-full-testimonials';
  const container = document.getElementById(elementId);
  container.innerHTML = '';

  const cityItems = (contentByCity[panelState.cityId] || [])
    .filter((item) => item.content_type === contentType);

  if (cityItems.length === 0) {
    container.innerHTML = '<div class="empty-state">No videos available yet</div>';
    return;
  }

  cityItems.forEach((item) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'video-item';

    const ytId = item.youtube_id;
    if (ytId) {
      const iframeHtml = `<iframe width="560" height="315" src="https://www.youtube.com/embed/${ytId}" title="${item.title || 'YouTube video'}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;

      // Thumbnail facade: show a clickable poster image and only load the
      // iframe when the user clicks play, avoiding YouTube's heavy JS upfront.
      const facade = document.createElement('div');
      facade.className = 'video-facade';
      facade.innerHTML = `<img class="video-thumb" src="https://img.youtube.com/vi/${ytId}/hqdefault.jpg" alt="${item.title || 'YouTube video'}"><div class="play-overlay"><div class="play-btn">&#9654;</div></div>`;
      facade.addEventListener('click', () => {
        const temp = document.createElement('div');
        temp.innerHTML = iframeHtml;
        wrapper.replaceChild(temp.firstChild, facade);
      });
      wrapper.appendChild(facade);
    }

    // Metadata row (shown when title or author is filled in)
    if (item.title || item.author || item.runtime) {
      const meta = document.createElement('div');
      meta.className = 'video-meta';
      if (item.title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'video-title';
        titleEl.textContent = item.title;
        meta.appendChild(titleEl);
      }
      const details = [];
      if (item.author) details.push(item.author);
      if (item.runtime) details.push(item.runtime);
      if (details.length) {
        const detailEl = document.createElement('div');
        detailEl.className = 'video-detail';
        detailEl.textContent = details.join(' · ');
        meta.appendChild(detailEl);
      }
      wrapper.appendChild(meta);
    }

    // Like / watch-later actions
    if (ytId && window.Account) {
      const actions = document.createElement('div');
      actions.className = 'video-actions';
      actions.appendChild(makeMarkButton('liked', ytId, panelState.cityId));
      actions.appendChild(makeMarkButton('watch_later', ytId, panelState.cityId));
      wrapper.appendChild(actions);
    }

    container.appendChild(wrapper);
  });
}

// Build a toggle button for a video mark ('liked' or 'watch_later').
// The 'liked' button also shows the public like count.
function makeMarkButton(kind, ytId, cityId) {
  const isLike = kind === 'liked';
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

  // Pre-render all three tab panes; history is shown first, video tabs are
  // hidden but their thumbnail facades are ready so switching is instant.
  switchTab('history');
  renderVideosPane('short_video');
  renderVideosPane('full_testimonial');

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

function openAccountPanel() {
  renderAccountPanel();
  document.getElementById('account-panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closeAccountPanel() {
  document.getElementById('account-panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');
}

// Which mark list is currently shown in the account panel.
let accountActiveKind = 'liked';

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
    `<button class="account-list-btn ${accountActiveKind === 'liked' ? 'active' : ''}" data-kind="liked">♥ Liked</button>` +
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
    const msg = kind === 'liked'
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
    btn.addEventListener('click', () => openMarkedVideo(mark.city_id, mark.youtube_id));
    view.appendChild(btn);
  });
}

// Open a city's panel from the account list and jump to the video's tab.
function openMarkedVideo(cityId, ytId) {
  const city = citiesData.find((c) => c.id === cityId);
  if (!city) return;
  closeAccountPanel();
  openPanel(city);

  const contentItem = (contentByCity[cityId] || []).find((c) => c.youtube_id === ytId);
  if (contentItem) {
    if (contentItem.content_type === 'short_video') switchTab('short-videos');
    else if (contentItem.content_type === 'full_testimonial') switchTab('full-testimonials');
  }
}

// ---- All Content panel ----

const CONTENT_TYPE_LABELS = {
  short_video: 'Short Video',
  full_testimonial: 'Full Testimonial',
  article: 'Article',
};

let contentPanelOrder = [];   // shuffled copy of contentData

function openContentPanel() {
  closePanel();
  closeAccountPanel();
  shuffleContentPanel();
  document.getElementById('content-panel').classList.add('visible');
  document.getElementById('map-overlay').classList.add('active');
}

function closeContentPanel() {
  document.getElementById('content-panel').classList.remove('visible');
  document.getElementById('map-overlay').classList.remove('active');
}

function shuffleContentPanel() {
  contentPanelOrder = [...contentData].sort(() => Math.random() - 0.5);
  renderContentPanel();
}

function renderContentPanel() {
  const list = document.getElementById('content-list');
  list.innerHTML = '';

  if (contentPanelOrder.length === 0) {
    list.innerHTML = '<div class="empty-state">No content yet.</div>';
    return;
  }

  contentPanelOrder.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = 'content-item';
    btn.addEventListener('click', () => openContentItem(item));

    // Thumbnail or article icon
    if (item.youtube_id) {
      const thumb = document.createElement('img');
      thumb.className = 'content-item-thumb';
      thumb.src = `https://img.youtube.com/vi/${item.youtube_id}/mqdefault.jpg`;
      thumb.alt = '';
      btn.appendChild(thumb);
    } else {
      const icon = document.createElement('div');
      icon.className = 'content-item-thumb content-item-article-icon';
      icon.textContent = '📄';
      btn.appendChild(icon);
    }

    // Info column
    const info = document.createElement('div');
    info.className = 'content-item-info';

    const title = document.createElement('div');
    title.className = 'content-item-title';
    title.textContent = item.title || 'Untitled';
    info.appendChild(title);

    const metaParts = [];
    if (item.author) metaParts.push(item.author);
    metaParts.push(CONTENT_TYPE_LABELS[item.content_type] || item.content_type);
    if (item.runtime) metaParts.push(item.runtime);
    const likeCount = window.Account ? Account.getLikeCount(item.youtube_id) : 0;
    if (likeCount > 0) metaParts.push(`♥ ${likeCount}`);

    const meta = document.createElement('div');
    meta.className = 'content-item-meta';
    meta.textContent = metaParts.join(' · ');
    info.appendChild(meta);

    btn.appendChild(info);
    list.appendChild(btn);
  });
}

// Open the relevant city panel when the user clicks a content item.
function openContentItem(item) {
  const cityId = (item.places || [])[0];
  if (!cityId) return;
  const city = citiesData.find((c) => c.id === cityId);
  if (!city) return;
  closeContentPanel();
  openPanel(city);
  if (item.content_type === 'short_video') switchTab('short-videos');
  else if (item.content_type === 'full_testimonial') switchTab('full-testimonials');
  // articles stay on the default 'history' tab
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
