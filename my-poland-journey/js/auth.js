// Supabase-backed accounts: Google sign-in + per-video "liked" / "watch later"
// marks, plus public aggregate like counts.
//
// The anon key is public by design; row-level security on the `video_marks`
// table restricts each user to their own rows. Like counts use a SECURITY
// DEFINER function so anonymous visitors can read aggregates without seeing
// individual rows.

(function () {
  const SUPABASE_URL = 'https://enkcyhrpxhpxoundqaez.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVua2N5aHJweGhweG91bmRxYWV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMDU4MDMsImV4cCI6MjEwMTY4MTgwM30.dNK5bZz00OmOi-e8-KejNDdrfNsd2uwlxkiT6H2IV7E';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('Supabase client failed to load; accounts disabled.');
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let currentUser = null;
  let marksList = [];               // [{ youtube_id, city_id, kind, created_at }]
  let marksKeys = new Set();        // `${kind}:${youtube_id}` for O(1) lookups
  let likeCountsCache = {};         // { youtube_id: count } — public, loaded on init
  const listeners = [];             // called on any auth/marks change

  function notify() {
    listeners.forEach((fn) => {
      try { fn(); } catch (err) { console.error('Account listener error:', err); }
    });
  }

  async function loadMarks() {
    const { data, error } = await sb
      .from('video_marks')
      .select('youtube_id, city_id, kind, created_at')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Failed to load marks:', error);
      marksList = [];
      marksKeys = new Set();
      return;
    }
    marksList = data || [];
    marksKeys = new Set(marksList.map((m) => `${m.kind}:${m.youtube_id}`));
  }

  // Loads aggregate like counts via a SECURITY DEFINER RPC so anon visitors
  // can see counts without reading individual user rows.
  async function loadLikeCounts() {
    const { data, error } = await sb.rpc('get_like_counts');
    if (error) {
      console.error('Failed to load like counts:', error);
      return;
    }
    likeCountsCache = {};
    (data || []).forEach((row) => {
      likeCountsCache[row.youtube_id] = Number(row.likes);
    });
  }

  function adjustLikeCount(youtubeId, delta) {
    likeCountsCache[youtubeId] = Math.max(0, (likeCountsCache[youtubeId] || 0) + delta);
  }

  // Load like counts immediately on page load (public, no auth required).
  loadLikeCounts();

  // Fires once on load (INITIAL_SESSION) and on every sign-in/sign-out.
  sb.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session ? session.user : null;
    if (currentUser) {
      await Promise.all([loadMarks(), loadLikeCounts()]);
    } else {
      marksList = [];
      marksKeys = new Set();
    }
    notify();
  });

  window.Account = {
    getUser() {
      return currentUser;
    },

    onChange(fn) {
      listeners.push(fn);
    },

    signInWithGoogle() {
      return sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
    },

    signOut() {
      return sb.auth.signOut();
    },

    isMarked(kind, youtubeId) {
      return marksKeys.has(`${kind}:${youtubeId}`);
    },

    getLikeCount(youtubeId) {
      return likeCountsCache[youtubeId] || 0;
    },

    // Adds or removes a mark; returns the new state (true = now marked).
    async toggleMark(kind, youtubeId, cityId) {
      if (!currentUser) throw new Error('Not signed in');
      const key = `${kind}:${youtubeId}`;
      if (marksKeys.has(key)) {
        const { error } = await sb
          .from('video_marks')
          .delete()
          .match({ user_id: currentUser.id, youtube_id: youtubeId, kind });
        if (error) throw error;
        marksKeys.delete(key);
        marksList = marksList.filter(
          (m) => !(m.kind === kind && m.youtube_id === youtubeId),
        );
        if (kind === 'liked') adjustLikeCount(youtubeId, -1);
        notify();
        return false;
      }
      const row = { user_id: currentUser.id, youtube_id: youtubeId, city_id: cityId, kind };
      const { error } = await sb.from('video_marks').insert(row);
      if (error) throw error;
      marksKeys.add(key);
      marksList.unshift({ ...row, created_at: new Date().toISOString() });
      if (kind === 'liked') adjustLikeCount(youtubeId, +1);
      notify();
      return true;
    },

    getMarks(kind) {
      return marksList.filter((m) => m.kind === kind);
    },
  };
})();
