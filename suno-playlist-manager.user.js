// ==UserScript==
// @name         Suno Playlist Manager
// @namespace    cjsharp.com
// @version      0.14.4
// @description  Two-panel drag-and-drop playlist manager for your Suno library
// @match        https://suno.com/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/cjsharp1/suno-playlist-manager
// @supportURL   https://github.com/cjsharp1/suno-playlist-manager/issues
// @updateURL    https://raw.githubusercontent.com/cjsharp1/suno-playlist-manager/main/suno-playlist-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/cjsharp1/suno-playlist-manager/main/suno-playlist-manager.user.js
// ==/UserScript==

// Changelog
// 0.14.4 Automatic updates from the GitHub repo.
// 0.14.3 Packaged for GitHub (MIT license).
// 0.14.2 Focus Mode eases the volume down over 3 s on entry, and back up on exit.
// 0.14.1 Removed the "Player bar" toggle; the overlay always leaves room for it.
// 0.14.0 Two-way sync with Suno: selecting a playlist opens its Suno page; playing
//        a song from a playlist plays it there, so Suno continues through the
//        playlist. Opening the overlay selects the playlist/song you're on in
//        Suno and quietly picks up changes made there. ♪ follows Suno's player.
// 0.13.x Focus Mode visualizer (toggle with artwork, or press V). Smoother
//        rendering; when idle, everything but the visualizer fades out.
// 0.12.x Shuffle and repeat in Focus Mode, lit when on.
// 0.11.0 Focus Mode: dark view of the current song with a big volume control
//        (drops to 25% or your last level, restored on exit).
// 0.10.x "Play playlist" button. Playlists over 50 songs load fully.
// 0.9.0  Folders: "Parent / Child" names nest in the playlist list.
// 0.8.x  Trash view with Restore. Hover a song for its title and style. The
//        overlay fits Suno's player bar exactly.
// 0.7.x  Playlist tags on songs, "+ New playlist", drag to reorder. Playing a
//        song selects it.
// 0.6.0  "All songs" and "Unsorted" entries replace the filter tabs.
// 0.5.0  Delete songs to Suno's Trash, with Undo.
// 0.4.0  Play through Suno's own player (Suno now encrypts streamed audio).
// 0.1–0.3 First version: two-panel layout, drag songs onto playlists,
//        playlist loading and Firefox fixes, and a built-in player since removed.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // API layer — undocumented Suno endpoints (mirrors what suno.com itself calls)
  // ---------------------------------------------------------------------------
  const API = 'https://studio-api-prod.suno.com';
  // In Firefox, a userscript may run in a sandbox where page globals (Clerk, Next's
  // router) are only reachable through wrappedJSObject.
  const pageWin = window.wrappedJSObject || window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getToken(forceRefresh = false) {
    // Preferred: the Clerk SDK the page already loaded.
    try {
      const session = pageWin.Clerk && pageWin.Clerk.session;
      if (session) {
        const t = await session.getToken(forceRefresh ? { skipCache: true } : undefined);
        if (t) return t;
      }
    } catch (e) { /* fall through to cookie */ }
    // Fallback: Clerk's __session cookie holds the short-lived JWT.
    const m = document.cookie.match(/(?:^|;\s*)__session(?:_[^=]*)?=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    throw new Error('Could not find a Suno session — are you signed in?');
  }

  function deviceId() {
    const ajs = document.cookie.match(/(?:^|;\s*)ajs_anonymous_id=([^;]+)/);
    if (ajs) return decodeURIComponent(ajs[1]).replace(/"/g, '');
    try {
      let id = localStorage.getItem('spm-device-id');
      if (!id) { id = crypto.randomUUID(); localStorage.setItem('spm-device-id', id); }
      return id;
    } catch (e) { return crypto.randomUUID(); }
  }

  function browserToken() {
    return JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) });
  }

  async function api(path, { method = 'GET', body } = {}) {
    let forceRefresh = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await getToken(forceRefresh);
      const res = await fetch(API + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'device-id': deviceId(),
          'browser-token': browserToken(),
          accept: '*/*',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 || res.status >= 500) { await sleep(800 * 2 ** attempt); continue; }
      if (res.status === 401 && !forceRefresh) { forceRefresh = true; continue; }
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : null;
    }
    throw new Error(`${method} ${path} kept failing (rate limited or server errors)`);
  }

  function normalizeClip(c) {
    const meta = c.metadata || {};
    return {
      id: c.id,
      title: c.title || '(untitled)',
      image: c.image_url || c.image_large_url || '',
      imageLarge: c.image_large_url || c.image_url || '',
      tags: meta.tags || '',
      duration: meta.duration || 0,
      created: c.created_at || '',
    };
  }

  async function fetchLibrary(onProgress, { trashed = false, maxPages = 100 } = {}) {
    const songs = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      const body = {
        limit: 50,
        filters: {
          ...(trashed ? {} : { disliked: 'False' }),
          trashed: trashed ? 'True' : 'False',
          fromStudioProject: { presence: 'False' },
          stem: { presence: 'False' },
          workspace: { presence: 'True', workspaceId: 'default' },
        },
      };
      if (cursor) body.cursor = cursor;
      const res = await api('/api/feed/v3', { method: 'POST', body });
      (res.clips || []).forEach((c) => songs.push(normalizeClip(c)));
      onProgress && onProgress(songs.length);
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return songs;
  }

  async function fetchPlaylists() {
    const all = [];
    for (let page = 1; page < 50; page++) {
      const res = await api(`/api/playlist/me?page=${page}`);
      const batch = ((res && res.playlists) || []).filter((pl) => !all.some((x) => x.id === pl.id));
      if (!batch.length) break; // empty page, or a page that only repeats ones we have
      all.push(...batch);
      const total = res.num_total_results || res.numTotalResults;
      if (total && all.length >= total) break;
    }
    return all
      .filter((p) => !p.is_trashed)
      .map((p) => ({
        id: p.id,
        name: p.name || (p.metadata && p.metadata.name) || '(unnamed)',
        count: p.song_count ?? p.num_total_results ?? null,
      }));
  }

  function idsFromPlaylistBody(body) {
    const p = (body && (body.playlist || body.data)) || body || {};
    const ids = new Set(p.clip_ids || p.clipIds || []);
    (p.playlist_clips || []).forEach((pc) => {
      const id = (pc.clip && pc.clip.id) || pc.clip_id || pc.id;
      if (id) ids.add(id);
    });
    return { ids, total: p.song_count ?? p.num_total_results ?? null };
  }

  // The legacy detail endpoint is what returns playlist_clips[]; the v2 one
  // apparently returns metadata only. Try legacy first, v2 as a fallback.
  const MEMBER_ENDPOINTS = [(id) => `/api/playlist/${id}/`, (id) => `/api/playlist/v2/${id}`];

  // Returns { ids, expected }. Suno returns playlist songs 50 per page, so keep
  // asking for ?page=N until we have the total Suno reports (or pages stop adding
  // anything new: page 1 may just repeat the unpaged response).
  async function fetchPlaylistMembers(id, expectedCount) {
    let lastBody = null;
    for (const endpoint of MEMBER_ENDPOINTS) {
      let body;
      try { body = await api(endpoint(id)); } catch (e) { console.warn('[SPM]', e.message); continue; }
      lastBody = body;
      const { ids, total } = idsFromPlaylistBody(body);
      if (!(ids.size > 0 || total === 0 || expectedCount === 0)) continue;
      const expected = Math.max(total || 0, expectedCount || 0);
      let misses = 0;
      for (let page = 1; page <= 60 && ids.size < expected && misses < 2; page++) {
        let pageBody;
        try { pageBody = await api(`${endpoint(id)}?page=${page}`); } catch (e) { console.warn('[SPM] paging', id, e.message); break; }
        const before = ids.size;
        idsFromPlaylistBody(pageBody).ids.forEach((x) => ids.add(x));
        misses = ids.size === before ? misses + 1 : 0;
      }
      if (ids.size < expected) console.warn(`[SPM] Playlist ${id}: loaded ${ids.size} of ${expected} songs`);
      return { ids, expected };
    }
    // Got responses but couldn't find any song ids in them — surface it instead
    // of silently reporting an empty playlist.
    console.error('[SPM] Could not find song ids in playlist response:', lastBody);
    const keys = lastBody && typeof lastBody === 'object' ? Object.keys(lastBody.playlist || lastBody).join(', ') : 'none';
    throw new Error(`No song ids in playlist response (keys: ${keys}) — full body logged to console`);
  }

  async function addToPlaylist(pid, clipIds) {
    for (let i = 0; i < clipIds.length; i += 20) {
      await api(`/api/playlist/v2/${pid}/tracks/add`, { method: 'POST', body: { clip_ids: clipIds.slice(i, i + 20) } });
    }
  }

  async function createPlaylistApi(name) {
    const body = await api('/api/playlist/create/', { method: 'POST', body: { name } });
    if (body && body.moderation_error_message) throw new Error(body.moderation_error_message);
    const p = (body && (body.playlist || body.data)) || body;
    if (!p || !p.id) throw new Error('Unexpected response from playlist create (logged to console)');
    return { id: p.id, name: p.name || name, count: 0 };
  }

  // Move one song to a zero-based position in the playlist.
  async function reorderApi(pid, clipId, index) {
    await api(`/api/playlist/v2/${pid}/tracks/reorder-by-index`, { method: 'POST', body: { positions: [{ clip_id: clipId, index }] } });
  }

  // Suno's delete is a trash toggle (restorable from Suno's Trash).
  async function setTrash(clipIds, trash) {
    for (let i = 0; i < clipIds.length; i += 20) {
      await api('/api/gen/trash', { method: 'POST', body: { trash, clip_ids: clipIds.slice(i, i + 20) } });
    }
  }

  async function removeFromPlaylist(pid, clipIds) {
    // One request per clip — large remove batches reportedly 500.
    for (const id of clipIds) {
      await api(`/api/playlist/v2/${pid}/tracks/remove`, { method: 'POST', body: { clip_ids: [id] } });
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    loaded: false,
    loading: false,
    songs: [],
    playlists: [],
    members: new Map(), // playlistId -> Set<clipId>
    selectedPlaylist: '__all', // '__all' | '__unsorted' | a playlist id
    allMembers: null,          // Promise while loading every playlist's songs
    allMembersReady: false,
    allMembersError: null,
    drag: null, // { ids, rowId } while dragging songs
    partial: new Map(), // playlistId -> song count Suno reports, when we couldn't load them all
    trash: null,        // trashed songs, once loaded
    trashLoading: null, // Promise while loading
    query: '',
    selection: new Set(),
    lastClicked: null,
    busy: 0,
    editSeq: 0, // bumped by every edit, so a background re-check knows if it's stale
    nowPlaying: null, // last song handed to Suno's player
  };

  // ---------------------------------------------------------------------------
  // UI (shadow DOM so Suno's styles don't leak in)
  // ---------------------------------------------------------------------------
  const host = document.createElement('div');
  host.id = 'spm-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .fab { position: fixed; right: 20px; bottom: 96px; z-index: 2147483646; background: #f5f5f4; color: #111;
      border: 0; border-radius: 999px; padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,.4); }
    .fab:hover { background: #fff; }
    .overlay { position: fixed; inset: 0; z-index: 2147483647; background: #0c0c0d; color: #e7e5e4;
      display: none; flex-direction: column; font-size: 13px; }
    .overlay.open { display: flex; }
    /* Leave room at the bottom so Suno's own player bar stays visible and usable. */
    .overlay.has-bar { border-bottom: 1px solid #333; box-shadow: 0 8px 24px rgba(0,0,0,.6); }
    header { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid #262626; }
    header h1 { font-size: 15px; margin: 0; font-weight: 650; flex: 1; }
    button.btn { background: #1f1f22; color: #e7e5e4; border: 1px solid #333; border-radius: 6px; padding: 6px 12px;
      font-size: 12px; cursor: pointer; }
    button.btn:hover:not(:disabled) { background: #2a2a2e; }
    button.btn:disabled { opacity: .45; cursor: default; }
    .body { flex: 1; display: grid; grid-template-columns: 300px 1fr; min-height: 0; }
    .panel { display: flex; flex-direction: column; min-height: 0; }
    .panel + .panel { border-left: 1px solid #262626; }
    .panel-head { padding: 12px 14px; border-bottom: 1px solid #1f1f1f; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .panel-head h2 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #a8a29e; flex: 1; }
    .list { flex: 1; overflow-y: auto; padding: 6px; }
    .pl { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px; cursor: pointer;
      border: 1px dashed transparent; }
    .pl:hover { background: #18181b; }
    .pl.sel { background: #232327; }
    .pl.drop { border-color: #f59e0b; background: #2a2115; }
    .pl .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pl .count { color: #78716c; font-variant-numeric: tabular-nums; }
    .pl.special .name { color: #d6d3d1; font-weight: 600; }
    .pl .sub { display: block; font-size: 11px; font-weight: 400; color: #78716c; }
    .pl-divider { height: 1px; background: #262626; margin: 6px 8px; }
    .pl.new .name { color: #a8a29e; }
    .pl .caret { width: 14px; flex: none; color: #78716c; font-size: 10px; text-align: center; cursor: pointer; }
    .pl .caret:empty { cursor: default; }
    .pl.folder .name { color: #a8a29e; font-style: italic; }
    .pl .addchild { display: none; background: none; border: 0; color: #a8a29e; cursor: pointer; font-size: 15px;
      line-height: 1; padding: 0 2px; }
    .pl:hover .addchild { display: inline; }
    .pl .addchild:hover { color: #fbbf24; }
    .pl.new:hover .name { color: #e7e5e4; }
    .chips { display: flex; gap: 4px; flex-wrap: nowrap; overflow: hidden; max-width: 260px; }
    .chip { font-size: 11px; color: #c4b5fd; background: #1e1b2e; border: 1px solid #312e4a; border-radius: 999px;
      padding: 1px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
    .chip.more { color: #a8a29e; background: transparent; border-color: #333; }
    .song.drop-before { box-shadow: inset 0 2px 0 #f59e0b; }
    .song.drop-after { box-shadow: inset 0 -2px 0 #f59e0b; }
    input.search { background: #18181b; border: 1px solid #333; color: #e7e5e4; border-radius: 6px; padding: 6px 10px;
      font-size: 12px; width: 220px; }
    .song { display: grid; grid-template-columns: 28px 36px 1fr auto auto auto; gap: 10px; align-items: center;
      padding: 6px 10px; border-radius: 6px; cursor: grab; user-select: none; }
    .song:hover { background: #18181b; }
    .song.picked { background: #1e293b; }
    .song img, .song .ph { width: 36px; height: 36px; border-radius: 4px; object-fit: cover; background: #27272a; }
    .song .t { overflow: hidden; }
    .song .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .song .tags { color: #78716c; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .song .dur { color: #78716c; font-variant-numeric: tabular-nums; font-size: 12px; }
    .play { width: 28px; height: 28px; border-radius: 50%; border: 1px solid #3f3f46; background: transparent;
      color: #e7e5e4; cursor: pointer; font-size: 11px; line-height: 1; padding: 0; }
    .play:hover:not(:disabled) { background: #e7e5e4; color: #111; }
    .play:disabled { opacity: .3; cursor: default; }
    .song.playing .play { background: #f59e0b; border-color: #f59e0b; color: #111; }
    .song.playing .title { color: #fbbf24; }
    .badge { font-size: 11px; color: #4ade80; display: flex; align-items: center; gap: 6px; }
    .x { background: none; border: 0; color: #a8a29e; cursor: pointer; font-size: 14px; padding: 0 4px; }
    .x:hover { color: #f87171; }
    .empty { color: #78716c; padding: 24px; text-align: center; }
    .hint { color: #78716c; font-size: 12px; }
    .toast { position: fixed; left: 50%; bottom: calc(var(--spm-bar, 0px) + 24px); transform: translateX(-50%); background: #e7e5e4; color: #111;
      padding: 8px 14px; border-radius: 8px; font-size: 12px; z-index: 2147483647; opacity: 0; transition: opacity .2s;
      pointer-events: none; max-width: 80vw; }
    .toast.show { opacity: 1; }
    .toast.err { background: #fecaca; }
    .toast.actionable { pointer-events: auto; }
    .toast-action { margin-left: 10px; background: #111; color: #fff; border: 0; border-radius: 4px; padding: 3px 10px;
      font-size: 12px; cursor: pointer; }
    button.btn.danger:not(:disabled) { border-color: #7f1d1d; color: #fca5a5; }
    button.btn.danger:hover:not(:disabled) { background: #3f1515; }
    /* ---- Focus Mode ---- */
    .focus { position: fixed; inset: 0; z-index: 2147483647; background: #000; color: #d6d3d1; display: none;
      align-items: center; justify-content: center; overflow: hidden; }
    .focus.open { display: flex; }
    .focus.idle { cursor: none; }
    .f-backdrop { position: absolute; inset: -60px; background-size: cover; background-position: center;
      filter: blur(70px) brightness(.22) saturate(1.2); opacity: .7; will-change: transform; }
    .f-center { position: relative; display: flex; flex-direction: column; align-items: center; gap: 14px;
      width: min(520px, 90vw); text-align: center; }
    .f-art { width: min(300px, 55vw, 40vh); aspect-ratio: 1; border-radius: 14px; object-fit: cover; background: #111;
      box-shadow: 0 20px 60px rgba(0,0,0,.7); }
    .f-art.none { display: none; }
    .f-title { font-size: 26px; font-weight: 300; color: #f5f5f4; letter-spacing: .01em; max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .f-tags { font-size: 13px; color: #78716c; max-width: 100%; display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden; min-height: 1em; }
    .f-progress { width: 100%; }
    .f-bar { height: 3px; background: #1c1917; border-radius: 2px; overflow: hidden; }
    .f-fill { height: 100%; width: 100%; background: #78716c; transform-origin: left; transform: scaleX(0);
      transition: transform .5s linear; will-change: transform; }
    .f-times { display: flex; justify-content: space-between; font-size: 11px; color: #57534e; margin-top: 6px;
      font-variant-numeric: tabular-nums; }
    .f-controls { display: flex; gap: 18px; align-items: center; }
    .f-btn { background: none; border: 1px solid #292524; color: #d6d3d1; width: 44px; height: 44px; border-radius: 50%;
      cursor: pointer; font-size: 14px; }
    .f-btn.f-toggle { width: 58px; height: 58px; font-size: 18px; }
    .f-btn:hover { border-color: #78716c; }
    .f-btn.f-mode { border-color: transparent; color: #57534e; position: relative; }
    .f-btn.f-mode svg { width: 18px; height: 18px; vertical-align: middle; }
    .f-btn.f-mode:hover { color: #a8a29e; border-color: transparent; }
    .f-btn.f-mode.on { color: #fbbf24; }
    .f-btn.f-mode .one { position: absolute; top: 9px; right: 8px; font-size: 9px; font-weight: 700; display: none; }
    .f-btn.f-mode.one-mode .one { display: block; }
    .f-volume { display: flex; align-items: center; gap: 14px; width: 100%; margin-top: 12px; }
    .f-volume svg { width: 22px; height: 22px; flex: none; color: #78716c; }
    .f-vol { flex: 1; -webkit-appearance: none; appearance: none; height: 8px; border-radius: 4px; background: #1c1917;
      outline: none; cursor: pointer; }
    .f-vol::-moz-range-progress { background: #a8a29e; height: 8px; border-radius: 4px; }
    .f-vol::-moz-range-track { background: #1c1917; height: 8px; border-radius: 4px; }
    .f-vol::-moz-range-thumb { width: 28px; height: 28px; border-radius: 50%; background: #e7e5e4; border: 0; }
    .f-vol::-webkit-slider-thumb { -webkit-appearance: none; width: 28px; height: 28px; border-radius: 50%; background: #e7e5e4; }
    .f-vol-val { width: 56px; text-align: right; font-size: 22px; font-weight: 300; color: #e7e5e4;
      font-variant-numeric: tabular-nums; }
    .f-note { font-size: 12px; color: #78716c; min-height: 16px; }
    .f-top { position: absolute; top: 18px; right: 20px; display: flex; gap: 8px; }
    .f-top button { background: none; border: 1px solid #292524; color: #78716c; border-radius: 6px; padding: 6px 12px;
      font-size: 12px; cursor: pointer; }
    .f-top button:hover { color: #d6d3d1; border-color: #57534e; }
    .f-viz { width: min(520px, 90vw); height: min(300px, 40vh); display: none; }
    .focus.viz .f-viz { display: block; }
    .focus.viz .f-art { display: none; }
    .f-controls, .f-volume, .f-top, .f-progress, .f-note, .f-art, .f-tags, .f-title { transition: opacity .8s; }
    .focus.idle .f-controls, .focus.idle .f-volume, .focus.idle .f-top, .focus.idle .f-progress, .focus.idle .f-note,
    .focus.idle .f-art, .focus.idle .f-tags, .focus.idle .f-title { opacity: .05; }
    .dragghost { position: fixed; top: -100px; left: -100px; background: #f59e0b; color: #111; padding: 4px 10px;
      border-radius: 999px; font-size: 12px; font-weight: 600; }
  </style>
  <button class="fab" title="Alt+P">♫ Playlists</button>
  <div class="overlay">
    <header>
      <h1>Playlist Manager</h1>
      <span class="hint status"></span>
      <button class="btn focus-btn" title="Focus Mode: dark listening view with its own volume">Focus</button>
      <button class="btn refresh">Refresh</button>
      <button class="btn close">Close</button>
    </header>
    <div class="body">
      <section class="panel">
        <div class="panel-head"><h2>Playlists</h2></div>
        <div class="list playlists"></div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2 class="songs-title">Library</h2>
          <button class="btn play-pl" title="Play this playlist in Suno's player">▶ Play playlist</button>
          <input class="search" placeholder="Filter by title or style…">
          <button class="btn remove-sel" disabled>Remove selected</button>
          <button class="btn restore-sel" disabled title="Move selected songs out of Suno's Trash">Restore</button>
          <button class="btn danger trash-sel" disabled title="Move selected songs to Suno's Trash (Delete key)">Delete</button>
        </div>
        <div class="list songs"></div>
      </section>
    </div>
  </div>
  <div class="focus">
    <div class="f-backdrop"></div>
    <div class="f-top">
      <button class="f-view" title="Switch between artwork and visualizer (V)">Visualizer</button>
      <button class="f-exit" title="Leave Focus Mode (Esc)">Exit focus</button>
    </div>
    <div class="f-center">
      <img class="f-art none" alt="">
      <canvas class="f-viz" aria-hidden="true"></canvas>
      <div class="f-title"></div>
      <div class="f-tags"></div>
      <div class="f-progress"><div class="f-bar"><div class="f-fill"></div></div>
        <div class="f-times"><span class="f-cur"></span><span class="f-dur"></span></div></div>
      <div class="f-controls">
        <button class="f-btn f-mode f-shuffle" title="Shuffle">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
        </button>
        <button class="f-btn f-prev" title="Previous">⏮</button>
        <button class="f-btn f-toggle" title="Play / pause (Space)">▶</button>
        <button class="f-btn f-next" title="Next">⏭</button>
        <button class="f-btn f-mode f-repeat" title="Repeat">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
          <span class="one">1</span>
        </button>
      </div>
      <div class="f-volume" title="Volume (↑ / ↓)">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
        <input type="range" class="f-vol" min="0" max="100" step="1" aria-label="Focus volume">
        <span class="f-vol-val"></span>
      </div>
      <div class="f-note"></div>
    </div>
  </div>
  <div class="toast"></div>
  <div class="dragghost"></div>
  `;

  const $ = (sel) => root.querySelector(sel);
  const overlay = $('.overlay');
  const plList = $('.playlists');
  const songList = $('.songs');
  const toastEl = $('.toast');
  const ghost = $('.dragghost');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

  let toastTimer;
  function toast(msg, isErr = false, action = null) {
    toastEl.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => { toastEl.className = 'toast'; action.fn(); }, { once: true });
      toastEl.append(' ', b);
    }
    toastEl.className = `toast show${isErr ? ' err' : ''}${action ? ' actionable' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = 'toast'), action ? 10000 : isErr ? 6000 : 2500);
  }
  function status(msg) { $('.status').textContent = msg || ''; }

  // ---------- rendering ----------
  const isFolder = (pid) => typeof pid === 'string' && pid.startsWith('__folder:');
  const isSpecial = (pid) => pid === '__all' || pid === '__unsorted' || pid === '__trash' || isFolder(pid);

  // ---- folders: "Parent / Child" names form a tree (display only) ----
  const SEP = /\s+\/\s+/;
  const pathParts = (name) => { const parts = String(name).split(SEP).map((x) => x.trim()).filter(Boolean); return parts.length ? parts : [String(name)]; };
  const normPath = (name) => pathParts(name).join(' / ');

  function buildTree() {
    const rootNode = { children: [], map: new Map() };
    state.playlists.forEach((p) => {
      const parts = pathParts(p.name);
      let node = rootNode;
      parts.forEach((seg, i) => {
        const path = parts.slice(0, i + 1).join(' / ');
        const last = i === parts.length - 1;
        let child = node.map.get(seg);
        if (!child || (last && child.playlist)) { // new node (or a second playlist with the same name)
          child = { seg, path, playlist: null, children: [], map: new Map() };
          node.children.push(child);
          if (!node.map.has(seg)) node.map.set(seg, child);
        }
        if (last) child.playlist = p;
        node = child;
      });
    });
    return rootNode;
  }

  // Playlists inside a folder path (the folder itself, if it's a playlist, plus all descendants).
  const folderPlaylists = (path) => state.playlists.filter((p) => { const n = normPath(p.name); return n === path || n.startsWith(path + ' / '); });

  // Combined song ids for a folder, in list order; null until all are loaded.
  function folderMemberIds(path) {
    const pls = folderPlaylists(path);
    if (pls.some((p) => !state.members.has(p.id))) return null;
    const ids = new Set();
    pls.forEach((p) => state.members.get(p.id).forEach((id) => ids.add(id)));
    return [...ids];
  }

  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(localStorage.getItem('spm-collapsed') || '[]')); } catch (e) { /* none */ }
  function saveCollapsed() { try { localStorage.setItem('spm-collapsed', JSON.stringify([...collapsed])); } catch (e) { /* ignore */ } }
  function expandTo(path) { const parts = path.split(' / '); for (let i = 1; i < parts.length; i++) collapsed.delete(parts.slice(0, i).join(' / ')); saveCollapsed(); }
  const inTrashView = () => state.selectedPlaylist === '__trash';

  // Members of the selected real playlist (null for the special entries or while loading).
  function currentMembers() {
    return isSpecial(state.selectedPlaylist) ? null : state.members.get(state.selectedPlaylist) || null;
  }

  function inAnyPlaylist() {
    const all = new Set();
    state.members.forEach((m) => m.forEach((id) => all.add(id)));
    return all;
  }

  function unsortedCount() {
    if (!state.allMembersReady) return null;
    const used = inAnyPlaylist();
    return state.songs.filter((s) => !used.has(s.id)).length;
  }

  function visibleSongs() {
    const sel = state.selectedPlaylist;
    let base;
    if (sel === '__all') base = state.songs;
    else if (sel === '__trash') base = state.trash || [];
    else if (isFolder(sel)) {
      const ids = folderMemberIds(sel.slice(9));
      if (!ids) return [];
      const byId = new Map(state.songs.map((s) => [s.id, s]));
      base = ids.map((id) => byId.get(id)).filter(Boolean);
    }
    else if (sel === '__unsorted') {
      if (!state.allMembersReady) return [];
      const used = inAnyPlaylist();
      base = state.songs.filter((s) => !used.has(s.id));
    } else {
      const members = currentMembers();
      if (!members) return []; // still loading
      const byId = new Map(state.songs.map((s) => [s.id, s]));
      base = [...members].map((id) => byId.get(id)).filter(Boolean); // playlist order
    }
    const q = state.query.trim().toLowerCase();
    return q ? base.filter((s) => s.title.toLowerCase().includes(q) || s.tags.toLowerCase().includes(q)) : base;
  }

  function renderPlaylists() {
    const sel = state.selectedPlaylist;
    const uc = unsortedCount();
    const special = `
      <div class="pl special${sel === '__all' ? ' sel' : ''}" data-pid="__all">
        <span class="name">All songs</span><span class="count">${state.songs.length || ''}</span></div>
      <div class="pl special${sel === '__unsorted' ? ' sel' : ''}" data-pid="__unsorted" title="Songs that aren't in any playlist">
        <span class="name">Unsorted<span class="sub">Not in any playlist</span></span>
        <span class="count">${uc ?? (state.allMembersError ? '!' : state.songs.length ? '…' : '')}</span></div>
      <div class="pl special${sel === '__trash' ? ' sel' : ''}" data-pid="__trash" title="Songs in Suno's Trash">
        <span class="name">Trash</span><span class="count">${state.trash ? state.trash.length : ''}</span></div>
      <div class="pl-divider"></div>`;
    const newRow = state.loaded ? `<div class="pl special new" data-pid="__new" title="Click to create, or drop songs here">
        <span class="name">+ New playlist</span></div>` : '';
    if (!state.playlists.length) {
      plList.innerHTML = special + `<div class="empty">${state.loading ? 'Loading…' : 'No playlists yet.'}</div>` + newRow;
      return;
    }
    const renderNode = (node, depth) => {
      const kids = node.children.length > 0;
      const isClosed = kids && collapsed.has(node.path);
      const pid = node.playlist ? node.playlist.id : `__folder:${node.path}`;
      let count = '';
      if (node.playlist) {
        const m = state.members.get(node.playlist.id);
        const short = state.partial.get(node.playlist.id);
        count = m ? (short ? `<span title="Only ${m.size} of ${short} songs could be loaded" style="color:#fbbf24">${m.size}/${short}</span>` : m.size)
          : node.playlist.count ?? '';
      }
      else { const ids = folderMemberIds(node.path); count = ids ? ids.length : ''; }
      const row = `<div class="pl${node.playlist ? '' : ' folder'}${pid === sel ? ' sel' : ''}" data-pid="${esc(pid)}"
          style="padding-left:${6 + depth * 16}px" title="${esc(node.playlist ? node.playlist.name : `Folder: ${node.path}`)}">
        <span class="caret"${kids ? ` data-toggle="${esc(node.path)}"` : ''}>${kids ? (isClosed ? '▸' : '▾') : ''}</span>
        <span class="name">${esc(node.seg)}</span>
        <button class="addchild" data-addchild="${esc(node.path)}" title="New playlist inside “${esc(node.path)}”">+</button>
        <span class="count">${count}</span></div>`;
      return row + (isClosed ? '' : node.children.map((c) => renderNode(c, depth + 1)).join(''));
    };
    plList.innerHTML = special + buildTree().children.map((n) => renderNode(n, 0)).join('') + newRow;
  }

  function renderSongs() {
    const sel = state.selectedPlaylist;
    const members = currentMembers();
    const pl = state.playlists.find((p) => p.id === sel);
    $('.songs-title').textContent = sel === '__all' ? 'All songs' : sel === '__unsorted' ? 'Unsorted' : sel === '__trash' ? 'Trash'
      : isFolder(sel) ? `${sel.slice(9)} (all playlists)` : pl ? pl.name : '';

    const selectedInPl = members && [...state.selection].some((id) => members.has(id));
    $('.remove-sel').style.display = members ? '' : 'none';
    $('.play-pl').style.display = isSpecial(sel) ? 'none' : '';
    $('.play-pl').disabled = !!members && members.size === 0;
    $('.remove-sel').disabled = !selectedInPl || state.busy > 0;
    $('.trash-sel').disabled = !state.selection.size || state.busy > 0;
    $('.trash-sel').style.display = inTrashView() ? 'none' : '';
    $('.restore-sel').style.display = inTrashView() ? '' : 'none';
    $('.restore-sel').disabled = !state.selection.size || state.busy > 0;
    $('.restore-sel').textContent = state.selection.size > 1 ? `Restore (${state.selection.size})` : 'Restore';
    $('.trash-sel').textContent = state.selection.size > 1 ? `Delete (${state.selection.size})` : 'Delete';

    const songs = visibleSongs();
    if (!songs.length) {
      const msg = state.loading ? 'Loading your library…'
        : state.query ? 'No songs match.'
        : sel === '__trash' ? (state.trash ? 'Trash is empty.' : 'Loading Trash…')
        : isFolder(sel) ? (folderMemberIds(sel.slice(9)) ? 'No songs in this folder yet.' : 'Loading folder…')
        : sel === '__unsorted' && state.allMembersError ? `Couldn't check every playlist: ${esc(state.allMembersError)}. Try Refresh.`
        : sel === '__unsorted' && !state.allMembersReady ? 'Checking which songs are in playlists…'
        : sel === '__unsorted' ? 'Every song is in at least one playlist.'
        : !isSpecial(sel) && !members ? 'Loading playlist…'
        : !isSpecial(sel) ? 'This playlist is empty — drag songs onto it from All songs or Unsorted.'
        : 'No songs yet.';
      songList.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    // song id -> playlists it's in (only playlists whose songs have loaded)
    const where = new Map();
    state.playlists.forEach((p) => {
      const m = state.members.get(p.id);
      if (m && p.id !== sel) m.forEach((id) => { if (!where.has(id)) where.set(id, []); where.get(id).push(p.name); });
    });
    const chipsFor = (id) => {
      const names = where.get(id) || [];
      if (!names.length) return '';
      const shown = names.slice(0, 3).map((n) => `<span class="chip">${esc(n)}</span>`).join('');
      const more = names.length > 3 ? `<span class="chip more">+${names.length - 3}</span>` : '';
      return `<span class="chips" title="${esc(names.join(', '))}">${shown}${more}</span>`;
    };
    songList.innerHTML = songs.map((s) => {
      const inPl = members && members.has(s.id);
      const playing = s.id === state.nowPlaying;
      return `<div class="song${state.selection.has(s.id) ? ' picked' : ''}${playing ? ' playing' : ''}" draggable="${inTrashView() ? 'false' : 'true'}" data-id="${esc(s.id)}" title="${esc(s.tags ? `${s.title}\n\nStyle: ${s.tags}` : s.title)}">
        ${inTrashView()
          ? '<button class="play" disabled title="Restore this song to play it">▶</button>'
          : `<button class="play" data-play="1" title="Play in Suno's player">${playing ? '♪' : '▶'}</button>`}
        ${s.image ? `<img src="${esc(s.image)}" loading="lazy" alt="${esc(s.title)}">` : '<div class="ph"></div>'}
        <div class="t"><div class="title">${esc(s.title)}</div><div class="tags">${esc(s.tags)}</div></div>
        ${chipsFor(s.id) || '<span></span>'}
        <span class="dur">${fmtDur(s.duration)}</span>
        <span>${inPl ? '<button class="x" title="Remove from this playlist" data-remove="1">×</button>' : ''}</span>
      </div>`;
    }).join('');
  }

  function render() { renderPlaylists(); renderSongs(); }

  // ---------- data loading ----------
  async function loadAll() {
    if (state.loading) return;
    state.loading = true;
    state.members.clear();
    state.partial.clear();
    state.selection.clear();
    state.allMembers = null;
    state.allMembersReady = false;
    state.allMembersError = null;
    state.trash = null;
    state.trashLoading = null;
    render();
    try {
      status('Loading playlists…');
      state.playlists = await fetchPlaylists();
      renderPlaylists();
      state.songs = await fetchLibrary((n) => status(`Loading library… ${n} songs`));
      state.loaded = true;
      status(`${plural(state.songs.length, 'song')} · ${plural(state.playlists.length, 'playlist')}`);
      if (!isSpecial(state.selectedPlaylist) && !state.playlists.some((p) => p.id === state.selectedPlaylist)) state.selectedPlaylist = '__all';
      ensureAllMembers(); // background
      syncFromPage();
      if (inTrashView()) ensureTrash().catch((e) => toast(`Couldn't load Trash: ${e.message}`, true));
    } catch (e) {
      console.error('[SPM]', e);
      toast(e.message, true);
      status('Load failed');
    } finally {
      state.loading = false;
      render();
    }
  }

  // Load every playlist's songs (3 at a time) so Unsorted can be computed.
  function ensureAllMembers() {
    if (state.allMembers) return state.allMembers;
    state.allMembersReady = false;
    state.allMembersError = null;
    const queue = state.playlists.map((p) => p.id);
    let done = 0;
    const failures = [];
    const worker = async () => {
      while (queue.length) {
        const pid = queue.shift();
        try { await ensureMembers(pid); } catch (e) { failures.push(e.message); console.warn('[SPM]', pid, e); }
        done++;
        if (done < state.playlists.length) status(`Checking playlists… ${done}/${state.playlists.length}`);
        renderPlaylists();
      }
    };
    state.allMembers = Promise.all([worker(), worker(), worker()]).then(() => {
      if (failures.length) state.allMembersError = `${failures.length} playlist(s) failed to load`;
      else state.allMembersReady = true;
      if (state.partial.size) toast(`${plural(state.partial.size, 'playlist')} couldn't fully load (shown as e.g. 50/72), so Unsorted may include songs that are in them.`, true);
      status(`${plural(state.songs.length, 'song')} · ${plural(state.playlists.length, 'playlist')}`);
      render();
    });
    return state.allMembers;
  }

  function ensureTrash() {
    if (!state.trashLoading) {
      state.trashLoading = fetchLibrary(null, { trashed: true })
        .then((songs) => { state.trash = songs; })
        .catch((e) => { state.trashLoading = null; throw e; })
        .finally(render);
    }
    return state.trashLoading;
  }

  async function ensureMembers(pid) {
    if (!state.members.has(pid)) {
      const pl = state.playlists.find((p) => p.id === pid);
      const { ids, expected } = await fetchPlaylistMembers(pid, pl ? pl.count : null);
      state.members.set(pid, ids);
      if (ids.size < expected) state.partial.set(pid, expected); else state.partial.delete(pid);
    }
    return state.members.get(pid);
  }

  async function selectPlaylist(pid) {
    if (pid !== state.selectedPlaylist) state.selection.clear();
    state.selectedPlaylist = pid;
    if (!isSpecial(pid)) navigateQuietly(`/playlist/${pid}`); // open it in Suno underneath
    render();
    if (pid === '__all' || !state.loaded) return;
    try {
      if (pid === '__unsorted') await ensureAllMembers();
      else if (pid === '__trash') await ensureTrash();
      else if (isFolder(pid)) await Promise.all(folderPlaylists(pid.slice(9)).map((p) => ensureMembers(p.id)));
      else await ensureMembers(pid);
    } catch (e) {
      toast(`Couldn't load ${pid === '__trash' ? 'Trash' : 'playlist'}: ${e.message}`, true);
    }
    render();
  }

  // ---------- mutations (optimistic) ----------
  async function doAdd(pid, ids) {
    const pl = state.playlists.find((p) => p.id === pid);
    let members;
    try { members = await ensureMembers(pid); } catch (e) { return toast(e.message, true); }
    const toAdd = ids.filter((id) => !members.has(id));
    if (!toAdd.length) return toast(`Already in “${pl.name}”`);
    toAdd.forEach((id) => members.add(id));
    state.busy++; state.editSeq++; render();
    try {
      await addToPlaylist(pid, toAdd);
      toast(`Added ${toAdd.length} song${toAdd.length > 1 ? 's' : ''} to “${pl.name}”`);
    } catch (e) {
      toAdd.forEach((id) => members.delete(id));
      toast(`Add failed: ${e.message}`, true);
    } finally { state.busy--; render(); }
  }

  async function doRemove(pid, ids) {
    const pl = state.playlists.find((p) => p.id === pid);
    const members = state.members.get(pid);
    const toRemove = ids.filter((id) => members && members.has(id));
    if (!toRemove.length) return;
    toRemove.forEach((id) => members.delete(id));
    toRemove.forEach((id) => state.selection.delete(id));
    state.busy++; state.editSeq++; render();
    const done = [];
    try {
      for (const id of toRemove) { await removeFromPlaylist(pid, [id]); done.push(id); }
      toast(`Removed ${done.length} from “${pl.name}”`);
    } catch (e) {
      toRemove.filter((id) => !done.includes(id)).forEach((id) => members.add(id));
      toast(`Remove failed after ${done.length}: ${e.message}`, true);
    } finally { state.busy--; render(); }
  }

  // ---------- create playlist ----------
  async function createFlow(ids = [], prefix = '') {
    const what = ids.length ? ` with ${ids.length} song${ids.length === 1 ? '' : 's'}` : '';
    const name = (prompt(`Name for the new playlist${what}:\n(Tip: “Parent / Child” puts it inside a folder.)`, prefix) || '').trim();
    if (!name || name === prefix.trim() || /\/$/.test(name)) return;
    expandTo(normPath(name));
    state.busy++; state.editSeq++; render();
    let pl;
    try {
      pl = await createPlaylistApi(name);
    } catch (e) {
      console.error('[SPM] create playlist', e);
      state.busy--; render();
      return toast(`Couldn't create playlist: ${e.message}`, true);
    }
    state.playlists.unshift(pl);
    state.members.set(pl.id, new Set());
    state.busy--;
    await selectPlaylist(pl.id);
    if (ids.length) await doAdd(pl.id, ids);
    else toast(`Created “${pl.name}”`);
  }

  // ---------- reorder within a playlist ----------
  const canReorder = () => !isSpecial(state.selectedPlaylist) && currentMembers() && !state.query.trim();

  async function doReorder(pid, dragId, targetId, after) {
    const members = state.members.get(pid);
    if (!members || dragId === targetId) return;
    const before = [...members];
    const order = before.filter((id) => id !== dragId);
    const to = order.indexOf(targetId) + (after ? 1 : 0);
    if (to < 0) return;
    order.splice(to, 0, dragId);
    if (order.every((id, i) => id === before[i])) return; // no change
    state.members.set(pid, new Set(order));
    state.busy++; state.editSeq++; render();
    try {
      await reorderApi(pid, dragId, to);
    } catch (e) {
      state.members.set(pid, new Set(before));
      toast(`Reorder failed: ${e.message}`, true);
    } finally { state.busy--; render(); }
  }

  // ---------- delete (move to Suno's Trash) ----------
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function takeSnapshot(ids) {
    return {
      ids,
      songs: ids.map((id) => ({ song: state.songs.find((s) => s.id === id), index: state.songs.findIndex((s) => s.id === id) })),
      memberships: [...state.members].map(([pid, set]) => [pid, ids.filter((id) => set.has(id))]).filter(([, m]) => m.length),
    };
  }
  function removeLocally(ids) {
    const gone = new Set(ids);
    state.songs = state.songs.filter((s) => !gone.has(s.id));
    state.members.forEach((m) => ids.forEach((id) => m.delete(id)));
    ids.forEach((id) => state.selection.delete(id));
  }
  function restoreLocally(snap) {
    [...snap.songs].sort((a, b) => a.index - b.index).forEach(({ song, index }) => {
      if (!state.songs.some((s) => s.id === song.id)) state.songs.splice(Math.min(index, state.songs.length), 0, song);
    });
    snap.memberships.forEach(([pid, ids]) => { const m = state.members.get(pid); if (m) ids.forEach((id) => m.add(id)); });
  }

  async function doTrash(ids) {
    ids = ids.filter((id) => state.songs.some((s) => s.id === id));
    if (!ids.length || state.busy) return;
    const titles = ids.map((id) => state.songs.find((s) => s.id === id).title);
    const preview = titles.slice(0, 5).map((t) => `• ${t}`).join('\n') + (titles.length > 5 ? `\n…and ${titles.length - 5} more` : '');
    if (!confirm(`Move ${plural(ids.length, 'song')} to Suno's Trash?\n\n${preview}\n\nYou can undo right after, or restore later from Suno's Trash.`)) return;
    const snap = takeSnapshot(ids);
    removeLocally(ids);
    state.busy++; state.editSeq++; render();
    try {
      await setTrash(ids, true);
      if (state.trash) state.trash.unshift(...snap.songs.map((x) => x.song));
      toast(`Moved ${plural(ids.length, 'song')} to Trash`, false, { label: 'Undo', fn: () => doRestore(snap) });
    } catch (e) {
      restoreLocally(snap);
      toast(`Delete failed: ${e.message}`, true);
    } finally { state.busy--; render(); }
  }

  async function doRestore(snap) {
    state.busy++; state.editSeq++; render();
    try {
      await setTrash(snap.ids, false);
      restoreLocally(snap);
      if (state.trash) state.trash = state.trash.filter((s) => !snap.ids.includes(s.id));
      toast(`Restored ${plural(snap.ids.length, 'song')}`);
    } catch (e) {
      toast(`Restore failed: ${e.message} — you can still restore from Suno's Trash.`, true);
    } finally { state.busy--; render(); }
  }

  // Restore from the Trash view. Suno keeps playlist membership for trashed songs
  // as far as we know, so re-check every playlist afterwards to keep Unsorted right.
  async function doRestoreFromTrash(ids) {
    const songs = (state.trash || []).filter((s) => ids.includes(s.id));
    if (!songs.length || state.busy) return;
    state.busy++; state.editSeq++; render();
    try {
      await setTrash(songs.map((s) => s.id), false);
      state.trash = state.trash.filter((s) => !ids.includes(s.id));
      ids.forEach((id) => state.selection.delete(id));
      state.songs.push(...songs);
      state.songs.sort((a, b) => (b.created || '').localeCompare(a.created || '')); // newest first, like Suno
      state.members.clear();
      state.allMembers = null;
      state.allMembersReady = false;
      ensureAllMembers();
      toast(`Restored ${plural(songs.length, 'song')}`);
    } catch (e) {
      toast(`Restore failed: ${e.message}`, true);
    } finally { state.busy--; render(); }
  }

  // ---------- playback (handed off to Suno's player) ----------
  const PLAYER_TAB = 'spm-suno-player';
  const AUTOPLAY_HASH = '#spm-play';

  async function waitFor(fn, timeout = 8000, interval = 200) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function inFixedBar(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  function buttonLabel(b) {
    return [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid')]
      .filter(Boolean).join(' ').toLowerCase();
  }

  // Best guess at the song page's own play/pause button: a visible button labelled
  // play or pause that is NOT inside the fixed player bar (that one controls
  // whatever is already loaded, not the song on this page).
  function findSongPlayButton() {
    const all = [...document.querySelectorAll('button, [role="button"]')];
    const cands = all.filter((b) => {
      const label = buttonLabel(b);
      return /\b(play|pause)\b/.test(label) && !/playlist|play ?next|queue|add to/.test(label)
        && b.getClientRects().length > 0 && !inFixedBar(b);
    });
    return cands[0] || null;
  }

  function logButtonCandidates() {
    const rows = [...document.querySelectorAll('button, [role="button"]')]
      .map((b) => ({ label: buttonLabel(b), visible: b.getClientRects().length > 0, fixedBar: inFixedBar(b) }))
      .filter((r) => r.label);
    console.warn('[SPM] Labelled buttons on this page (for tuning the play-button guess):', rows);
  }

  // On a playlist page: prefer a button labelled like "play playlist" / "play all";
  // otherwise the biggest play button outside the player bar (the header's, not a
  // track row's).
  function findPlaylistPlayButton() {
    const cands = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
      const label = buttonLabel(b);
      return /\b(play|pause)\b/.test(label) && !/play ?next|queue|add to/.test(label)
        && b.getClientRects().length > 0 && !inFixedBar(b);
    });
    const named = cands.find((b) => /\b(play|pause)\s+(the\s+)?(playlist|all)\b/.test(buttonLabel(b)));
    if (named) return named;
    const area = (b) => { const r = b.getBoundingClientRect(); return r.width * r.height; };
    return cands.sort((a, b) => area(b) - area(a))[0] || null;
  }

  // target: { kind: 'song' | 'playlist', id, title }
  async function clickPagePlay(target) {
    // Give the new page a moment to render (the old page's buttons can linger).
    await waitFor(() => (document.body.innerText || '').includes(target.title), 3000);
    const btn = await waitFor(target.kind === 'playlist' ? findPlaylistPlayButton : findSongPlayButton, 8000);
    if (!btn) {
      logButtonCandidates();
      toast(`Opened “${target.title}” in Suno, but couldn't find its play button. Use Suno's player bar, or see console.`, true);
      return false;
    }
    if (/\bpause\b/.test(buttonLabel(btn))) { toast(`“${target.title}” is already playing`); return true; }
    btn.click();
    const started = await waitFor(() => [...document.querySelectorAll('audio, video')].some((m) => !m.paused), 4000);
    if (!started) console.warn('[SPM] Clicked Suno\'s play button; no <audio>/<video> reported playing (Suno may use Web Audio, so this may be fine).', btn);
    return true;
  }

  function openPlayerTab(target, why) {
    const w = window.open(`https://suno.com/${target.kind}/${target.id}${AUTOPLAY_HASH}`, PLAYER_TAB);
    if (!w) return toast('Firefox blocked the pop-up. Allow pop-ups for suno.com and try again.', true);
    console.info('[SPM] Using the separate player tab:', why);
    toast(`Playing “${target.title}” in the Suno player tab`);
  }

  // Load the song/playlist page underneath the overlay with Suno's own (Next.js)
  // router — no reload, so the overlay and its state survive — then click play.
  // The router check and push happen synchronously in the click, so the pop-up
  // fallback still counts as user-initiated.
  async function handOff(target) {
    const path = `/${target.kind}/${target.id}`;
    if (location.pathname !== path) {
      const router = pageWin.next && pageWin.next.router;
      if (!router || typeof router.push !== 'function') return openPlayerTab(target, 'no Next.js router on window.next');
      try { router.push(path); } catch (e) { return openPlayerTab(target, `router.push threw: ${e.message}`); }
      const moved = await waitFor(() => location.pathname === path, 5000);
      if (!moved) {
        console.warn('[SPM] router.push did not navigate; falling back to the player tab');
        return openPlayerTab(target, 'router.push did not change the URL');
      }
    }
    return clickPagePlay(target);
  }

  // Change the page underneath without playing anything. Returns false if
  // Suno's router isn't reachable.
  function navigateQuietly(path) {
    if (location.pathname === path) return true;
    const router = pageWin.next && pageWin.next.router;
    if (!router || typeof router.push !== 'function') return false;
    try { router.push(path); return true; } catch (e) { console.warn('[SPM] navigate:', e); return false; }
  }

  const songIdFromHref = (href) => (String(href || '').match(/\/song\/([^/?#]+)/) || [])[1];

  // On a playlist page, find this song's row: walk up from its link until the
  // container would also hold another song. Returns { row, btn } (btn may be null
  // if the row only renders its play button on hover).
  function findTrackRow(id) {
    const links = [...document.querySelectorAll(`a[href*="/song/${id}"]`)].filter((a) => !inFixedBar(a));
    for (const a of links) {
      let row = null;
      for (let el = a.parentElement; el && el !== document.body; el = el.parentElement) {
        const ids = new Set([...el.querySelectorAll('a[href*="/song/"]')].map((x) => songIdFromHref(x.getAttribute('href'))));
        if (ids.size > 1) break; // walked past this song's row
        row = el;
        const btn = [...el.querySelectorAll('button, [role="button"]')].find((b) => {
          const l = buttonLabel(b);
          return /\b(play|pause)\b/.test(l) && !/playlist|queue|next|previous|add to/.test(l);
        });
        if (btn) return { row: el, btn };
      }
      if (row) return { row, btn: null };
    }
    return null;
  }

  // Play a song from its playlist's page so Suno queues the rest of the playlist.
  async function playTrackInPlaylist(pl, song) {
    const path = `/playlist/${pl.id}`;
    if (location.pathname !== path) {
      if (!navigateQuietly(path)) return false;
      if (!(await waitFor(() => location.pathname === path, 5000))) return false;
    }
    // Wait for the playlist's songs to render, then give this song's row a moment.
    await waitFor(() => [...document.querySelectorAll('a[href*="/song/"]')].some((a) => !inFixedBar(a)), 6000);
    let found = await waitFor(() => findTrackRow(song.id), 1500);
    if (!found) return false;
    if (!found.btn) {
      // Many track lists only render the row's play button on hover.
      ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach((type) =>
        found.row.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter' })));
      found = (await waitFor(() => { const f = findTrackRow(song.id); return f && f.btn ? f : null; }, 1500)) || found;
    }
    if (!found.btn) return false;
    if (/\bpause\b/.test(buttonLabel(found.btn))) { toast(`“${song.title}” is already playing`); return true; }
    found.btn.click();
    return true;
  }

  async function playInSuno(id) {
    const song = state.songs.find((s) => s.id === id);
    if (!song) return;
    state.nowPlaying = id;
    manualPlayAt = Date.now();
    updatePlayIcons();
    const pl = state.playlists.find((p) => p.id === state.selectedPlaylist);
    const members = currentMembers();
    if (pl && members && members.has(id)) {
      if (await playTrackInPlaylist(pl, song)) return status(`Playing in Suno: ${song.title} (from ${pl.name})`);
      logButtonCandidates();
      toast(`Couldn't find “${song.title}” on the playlist page, so it's playing on its own.`, true);
    }
    if (await handOff({ kind: 'song', id, title: song.title })) status(`Playing in Suno: ${song.title}`);
  }

  async function playPlaylistInSuno(pid) {
    const pl = state.playlists.find((p) => p.id === pid);
    if (!pl) return;
    state.nowPlaying = null;
    updatePlayIcons();
    if (await handOff({ kind: 'playlist', id: pid, title: pl.name })) status(`Playing playlist in Suno: ${pl.name}`);
  }

  function updatePlayIcons() {
    songList.querySelectorAll('.song').forEach((row) => {
      const playing = row.dataset.id === state.nowPlaying;
      row.classList.toggle('playing', playing);
      const btn = row.querySelector('.play');
      if (!btn.disabled) btn.textContent = playing ? '♪' : '▶';
    });
  }

  // In the separate player tab, this same script finishes the job: click play.
  if (location.hash === AUTOPLAY_HASH) {
    history.replaceState(null, '', location.pathname + location.search);
    const m = location.pathname.match(/^\/(song|playlist)\/([^/]+)/);
    if (m) {
      clickPagePlay({ kind: m[1], id: m[2], title: document.title.replace(/\s*[|-]\s*Suno.*$/i, '') || m[2] })
        .then((ok) => { if (ok) console.info('[SPM] Player tab: clicked play (if nothing plays, allow autoplay for suno.com in Firefox).'); });
    }
  }

  // Find Suno's player bar: starting from whatever is at the bottom-centre of the
  // window, walk up to the widest box that hugs the bottom edge and is under 200px
  // tall. Returns the height to leave free (0 when there's no bar).
  // Finding the bar forces a layout of Suno's (heavy) page, so cache the result:
  // reuse a found bar for 3 s while it's still in the page, and "no bar" for 1 s.
  const barCache = { result: null, at: 0 };
  function findPlayerBar() {
    const now = Date.now();
    const r = barCache.result;
    if (r ? r.el.isConnected && now - barCache.at < 3000 : now - barCache.at < 1000) return r;
    barCache.result = lookUpPlayerBar();
    barCache.at = now;
    return barCache.result;
  }
  const forgetPlayerBar = () => { barCache.at = 0; barCache.result = null; };

  function lookUpPlayerBar() {
    if (typeof document.elementsFromPoint !== 'function') return null;
    const vw = window.innerWidth, vh = window.innerHeight;
    const stack = document.elementsFromPoint(vw / 2, vh - 3).filter((el) => el !== host && !host.contains(el));
    let best = null;
    for (const start of stack) {
      for (let el = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        const r = el.getBoundingClientRect();
        if (r.height > 200) break;
        if (r.bottom >= vh - 4 && r.height >= 40 && r.width >= vw * 0.6 && (!best || r.top < best.top)) best = { el, top: r.top };
      }
      if (best) break;
    }
    return best;
  }
  function measurePlayerBar() {
    const bar = findPlayerBar();
    return bar ? Math.ceil(window.innerHeight - bar.top) : 0;
  }

  let barHeight = -1;
  function layoutForBar() {
    const h = measurePlayerBar();
    if (h === barHeight) return;
    barHeight = h;
    overlay.style.bottom = `${h}px`;
    overlay.classList.toggle('has-bar', h > 0);
    root.host.style.setProperty('--spm-bar', `${h}px`);
  }
  let barTimer = null;
  function watchBar(on) {
    clearInterval(barTimer);
    barTimer = on ? setInterval(() => { layoutForBar(); syncNowPlaying(); }, 1000) : null;
    if (on) { barHeight = -1; layoutForBar(); }
  }
  window.addEventListener('resize', () => { forgetPlayerBar(); if (overlay.classList.contains('open')) { barHeight = -1; layoutForBar(); } });

  // ---------- Focus Mode: dark listening view with its own volume ----------
  const focusEl = $('.focus');
  // level: the volume we're holding Suno's audio at (null = leave it alone). It
  // follows the fade on entry/exit, then sits at focusVolume while in Focus.
  const focus = { on: false, timer: null, idleTimer: null, prevVolume: null, corrections: 0, since: 0, lastKey: '', level: null };
  const fade = { timer: null };
  const FADE_MS = 3000;
  const trackedMedia = new WeakSet();
  let focusVolume = 0.25;
  try { const v = parseFloat(localStorage.getItem('spm-focus-volume')); if (v >= 0 && v <= 1) focusVolume = v; } catch (e) { /* default */ }

  const mediaEls = () => [...document.querySelectorAll('audio, video')];
  const activeMedia = () => { const m = mediaEls(); return m.find((x) => !x.paused) || m.find((x) => x.currentSrc) || m[0] || null; };

  // Keep Suno's own volume slider in step, so its state doesn't fight ours.
  function setSunoSlider(v) {
    const bar = findPlayerBar();
    const el = (bar ? bar.el : document).querySelector('input[type="range"][aria-label*="olume" i]');
    if (!el) return false;
    const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 1;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(min + v * (max - min)));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function enforceVolume(m) {
    if (focus.level === null || Math.abs(m.volume - focus.level) < 0.005) return;
    const now = Date.now();
    if (now - focus.since > 2000) { focus.corrections = 0; focus.since = now; }
    if (++focus.corrections > 20) return; // something keeps resetting it; don't fight in a tight loop
    m.volume = focus.level;
  }

  function setLevel(v) {
    focus.level = v;
    mediaEls().forEach((m) => { if (Math.abs(m.volume - v) >= 0.005) m.volume = v; });
  }

  function stopFade() { clearInterval(fade.timer); fade.timer = null; }

  // Slide the held level to `to` over FADE_MS. Eased in time, and moved in
  // square-root space so the change in loudness feels even (not front-loaded).
  function fadeLevel(to, done) {
    stopFade();
    const from = focus.level === null ? to : focus.level;
    if (Math.abs(from - to) < 0.005) { setLevel(to); if (done) done(); return; }
    const a = Math.sqrt(from), b = Math.sqrt(to), start = Date.now();
    fade.timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / FADE_MS);
      const e = t * t * (3 - 2 * t); // smoothstep
      const x = a + (b - a) * e;
      setLevel(Math.round(x * x * 1000) / 1000);
      if (t >= 1) { stopFade(); setLevel(to); if (done) done(); }
    }, 40);
  }

  // Apply the focus volume to every media element, now and whenever Suno touches it.
  function applyFocusVolume() {
    const els = mediaEls();
    els.forEach((m) => {
      if (focus.on && focus.prevVolume === null) focus.prevVolume = m.volume;
      if (!trackedMedia.has(m)) {
        trackedMedia.add(m);
        ['volumechange', 'play', 'loadedmetadata'].forEach((ev) => m.addEventListener(ev, () => enforceVolume(m)));
      }
      enforceVolume(m);
    });
    return els.length > 0;
  }

  function nowPlaying() {
    const bar = findPlayerBar();
    if (!bar) return null;
    const link = bar.el.querySelector('a[href*="/song/"]');
    const id = link ? (link.getAttribute('href').match(/\/song\/([^/?#]+)/) || [])[1] : null;
    const song = id ? state.songs.find((s) => s.id === id) || (state.trash || []).find((s) => s.id === id) : null;
    const img = bar.el.querySelector('img');
    return {
      key: id || (link && link.textContent) || (img && img.src) || '',
      title: (song && song.title) || (link && link.textContent.trim()) || (img && img.alt) || '',
      tags: song ? song.tags : '',
      image: (song && song.imageLarge) || (img && img.src) || '',
    };
  }

  function barButton(re, not) {
    const bar = findPlayerBar();
    if (!bar) return null;
    return [...bar.el.querySelectorAll('button, [role="button"]')].find((b) => { const l = buttonLabel(b); return re.test(l) && !(not && not.test(l)); }) || null;
  }
  const findToggle = () => barButton(/\b(play|pause)\b/, /playlist|queue|next|previous|shuffle|repeat|loop/);
  const findNext = () => barButton(/\b(next|skip)\b/, /play ?next|queue/);
  const findPrev = () => barButton(/\b(previous|prev)\b/);
  const findShuffle = () => barButton(/shuffle/);
  const findRepeat = () => barButton(/repeat|loop/);

  // Best guess at whether one of Suno's toggle buttons is on: accessibility state
  // first, then wording in its label. null = can't tell.
  function toggleState(btn) {
    const attr = btn.getAttribute('aria-pressed') || btn.getAttribute('aria-checked');
    if (attr === 'true' || attr === 'mixed') return true;
    if (attr === 'false') return false;
    // Suno's player bar marks an off toggle with data-inactive="" and drops it when on.
    if (btn.hasAttribute('data-inactive')) return btn.getAttribute('data-inactive') === 'false';
    if (/^playbar:/.test(buttonLabel(btn))) return true;
    const ds = (btn.getAttribute('data-state') || btn.getAttribute('data-active') || '').toLowerCase();
    if (/^(on|active|checked|true|all|one)$/.test(ds)) return true;
    if (/^(off|inactive|unchecked|false)$/.test(ds)) return false;
    const label = buttonLabel(btn);
    // The button's label usually names the action it will take, so "turn off" means it's on now.
    if (/\b(disable|turn off|stop)\b/.test(label)) return true;
    if (/\b(enable|turn on)\b/.test(label)) return false;
    if (/\b(on|enabled|all|one)\b/.test(label)) return true;
    if (/\b(off|disabled)\b/.test(label)) return false;
    return null;
  }
  const unknownLogged = new Set();
  function showModeButton(el, btn, kind) {
    el.style.visibility = btn ? '' : 'hidden';
    if (!btn) return;
    const on = toggleState(btn);
    const label = buttonLabel(btn);
    el.classList.toggle('on', on === true);
    el.classList.toggle('one-mode', kind === 'repeat' && on !== false && /\b(one|single|track|song)\b/.test(label));
    el.title = `${kind === 'shuffle' ? 'Shuffle' : 'Repeat'}${on === true ? ': on' : on === false ? ': off' : ''}${label ? ` (Suno: “${label}”)` : ''}`;
    if (on === null && !unknownLogged.has(kind)) {
      unknownLogged.add(kind);
      console.info(`[SPM] Can't tell if Suno's ${kind} is on. Its button:`, btn.outerHTML.slice(0, 400));
    }
  }

  const fmtTime = (t) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '');

  function updateFocus() {
    const np = nowPlaying();
    const m = activeMedia();
    if (!np || !np.key) {
      if (focus.lastKey !== '') {
        focus.lastKey = '';
        $('.f-title').textContent = 'Nothing playing';
        $('.f-tags').textContent = 'Start a song or playlist, then come back to Focus.';
        $('.f-art').classList.add('none');
        $('.f-backdrop').style.backgroundImage = '';
      }
    } else if (np.key !== focus.lastKey) {
      focus.lastKey = np.key;
      $('.f-title').textContent = np.title || 'Unknown song';
      $('.f-title').title = np.title;
      $('.f-tags').textContent = np.tags;
      $('.f-tags').title = np.tags;
      const art = $('.f-art');
      if (np.image) { art.src = np.image; art.alt = np.title; art.classList.remove('none'); } else art.classList.add('none');
      $('.f-backdrop').style.backgroundImage = np.image ? `url("${np.image.replace(/"/g, '%22')}")` : '';
    }
    const dur = m && Number.isFinite(m.duration) && m.duration > 0 ? m.duration : null;
    $('.f-fill').style.transform = `scaleX(${dur ? Math.min(1, m.currentTime / dur).toFixed(4) : 0})`;
    $('.f-cur').textContent = m && dur ? fmtTime(m.currentTime) : '';
    $('.f-dur').textContent = dur ? fmtTime(dur) : '';
    $('.f-toggle').textContent = m && !m.paused ? '❚❚' : '▶';
    $('.f-prev').style.visibility = findPrev() ? '' : 'hidden';
    $('.f-next').style.visibility = findNext() ? '' : 'hidden';
    showModeButton($('.f-shuffle'), findShuffle(), 'shuffle');
    showModeButton($('.f-repeat'), findRepeat(), 'repeat');
    $('.f-note').textContent = np && np.key && !m ? "Couldn't find Suno's audio, so the volume here may not take effect." : '';
  }

  function showFocusVolume() {
    $('.f-vol').value = String(Math.round(focusVolume * 100));
    $('.f-vol-val').textContent = `${Math.round(focusVolume * 100)}%`;
  }

  function setFocusVolume(v, syncSlider = true) {
    focusVolume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    try { localStorage.setItem('spm-focus-volume', String(focusVolume)); } catch (e) { /* ignore */ }
    focus.corrections = 0;
    stopFade(); // a manual change takes over from any fade in progress
    setLevel(focusVolume);
    applyFocusVolume();
    if (syncSlider) setSunoSlider(focusVolume);
    showFocusVolume();
  }

  function focusToggle() {
    const btn = findToggle();
    if (btn) return btn.click();
    const m = activeMedia();
    if (m) (m.paused ? m.play() : m.pause()); // fallback: drive the audio directly
  }

  function wakeFocus() {
    focusEl.classList.remove('idle');
    clearTimeout(focus.idleTimer);
    focus.idleTimer = setTimeout(() => focusEl.classList.add('idle'), 3500);
  }

  function enterFocus() {
    if (focus.on) return;
    focus.on = true;
    focus.lastKey = null;
    focus.corrections = 0;
    if (focus.level === null) {
      // Not mid-fade from a previous exit: remember the volume to come back to,
      // and start the fade from wherever Suno is now.
      const m = activeMedia();
      focus.prevVolume = m ? m.volume : null;
      focus.level = m ? m.volume : focusVolume;
    } // else: re-entering during the exit fade keeps the original volume to return to
    applyFocusVolume(); // start holding Suno's audio at the current level
    fadeLevel(focusVolume, () => setSunoSlider(focusVolume));
    showFocusVolume();
    focusEl.classList.add('open');
    $('.fab').style.display = 'none';
    clearInterval(barTimer); // the overlay's gap check is pointless under Focus
    forgetPlayerBar();
    updateFocus();
    focus.timer = setInterval(() => { applyFocusVolume(); updateFocus(); updateVizNote(); }, 500);
    wakeFocus();
    setVizMode(vizMode, true);
  }

  function updateVizNote() {
    if (vizMode && viz.error && !$('.f-note').textContent) $('.f-note').textContent = viz.error;
  }

  function exitFocus() {
    if (!focus.on) return;
    focus.on = false;
    clearInterval(focus.timer);
    clearTimeout(focus.idleTimer);
    focusEl.classList.remove('open', 'idle');
    if (focus.prevVolume !== null) {
      const back = focus.prevVolume;
      fadeLevel(back, () => { setSunoSlider(back); focus.level = null; focus.prevVolume = null; });
    } else { stopFade(); focus.level = null; }
    if (!overlay.classList.contains('open')) $('.fab').style.display = '';
    else watchBar(true);
  }

  $('.focus-btn').addEventListener('click', enterFocus);
  $('.f-exit').addEventListener('click', exitFocus);
  $('.f-toggle').addEventListener('click', focusToggle);
  $('.f-next').addEventListener('click', () => { const b = findNext(); if (b) b.click(); });
  $('.f-prev').addEventListener('click', () => { const b = findPrev(); if (b) b.click(); });
  [['.f-shuffle', findShuffle], ['.f-repeat', findRepeat]].forEach(([sel, find]) => {
    $(sel).addEventListener('click', () => { const b = find(); if (b) { b.click(); setTimeout(updateFocus, 150); } });
  });
  $('.f-vol').addEventListener('input', (e) => setFocusVolume(e.target.value / 100, false));
  $('.f-vol').addEventListener('change', (e) => setFocusVolume(e.target.value / 100, true));
  focusEl.addEventListener('mousemove', wakeFocus);

  // ---------- Focus Mode visualizer ----------
  // Tapping the audio means routing Suno's <audio> through our own AudioContext,
  // which lasts until the page reloads. To never leave it silent, we only hook in
  // once the context is confirmed running, and fall back to a direct connection
  // if anything fails part-way.
  const viz = { ctx: null, analysers: new WeakMap(), failed: new WeakSet(), raf: 0, error: '', buf: null, levels: null };
  let vizMode = false;
  try { vizMode = localStorage.getItem('spm-focus-view') === 'viz'; } catch (e) { /* artwork */ }
  const vizCanvas = $('.f-viz');

  async function startAudioEngine() { // call from a click/keypress
    try {
      if (!viz.ctx) viz.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (viz.ctx.state !== 'running') await viz.ctx.resume();
      return viz.ctx.state === 'running';
    } catch (e) { viz.error = `Audio engine unavailable: ${e.message}`; return false; }
  }

  function analyserFor(m) {
    if (viz.analysers.has(m)) return viz.analysers.get(m);
    if (viz.failed.has(m) || !viz.ctx || viz.ctx.state !== 'running') return null;
    let src;
    try { src = viz.ctx.createMediaElementSource(m); } catch (e) {
      viz.failed.add(m);
      viz.error = "Suno's audio can't be tapped for a visualizer (it's already routed elsewhere).";
      console.warn('[SPM] visualizer:', e);
      return null;
    }
    try {
      const an = viz.ctx.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.82;
      src.connect(an);
      an.connect(viz.ctx.destination);
      viz.analysers.set(m, an);
      return an;
    } catch (e) {
      try { src.connect(viz.ctx.destination); } catch (_) { /* nothing more we can do */ }
      viz.failed.add(m);
      viz.error = `Visualizer failed: ${e.message}`;
      return null;
    }
  }

  function drawViz() {
    if (!focus.on || !vizMode) { viz.raf = 0; return; }
    viz.raf = requestAnimationFrame(drawViz);
    const dpr = window.devicePixelRatio || 1;
    const W = vizCanvas.clientWidth, H = vizCanvas.clientHeight;
    if (!W || !H) return;
    if (vizCanvas.width !== Math.round(W * dpr) || vizCanvas.height !== Math.round(H * dpr)) {
      vizCanvas.width = Math.round(W * dpr); vizCanvas.height = Math.round(H * dpr);
    }
    const g = vizCanvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const m = activeMedia();
    const an = m ? analyserFor(m) : null;
    if (m && !an && viz.failed.has(m)) { setVizMode(false, false, false); toast(viz.error || "The visualizer isn't available.", true); return; }
    const N = 48;
    if (!viz.levels) viz.levels = new Float32Array(N);
    if (an) {
      // Keep the picture lively at low volume: shift the dB window with the volume.
      const db = 20 * Math.log10(Math.max(m.volume, 0.05));
      an.maxDecibels = Math.min(-10, -28 + db);
      an.minDecibels = an.maxDecibels - 65;
      if (!viz.buf || viz.buf.length !== an.frequencyBinCount) viz.buf = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(viz.buf);
    }
    const bins = viz.buf ? viz.buf.length : 0;
    const gap = W / N, bw = Math.max(2, gap * 0.55), mid = H / 2;
    for (let i = 0; i < N; i++) {
      let v = 0;
      if (an && bins) {
        // Log-spaced bins so bass doesn't hog the picture.
        const lo = Math.floor(2 * Math.pow((bins * 0.72) / 2, i / N));
        const hi = Math.max(lo + 1, Math.floor(2 * Math.pow((bins * 0.72) / 2, (i + 1) / N)));
        for (let b = lo; b < hi; b++) v = Math.max(v, viz.buf[b]);
        v /= 255;
      }
      viz.levels[i] = Math.max(v, viz.levels[i] * 0.9); // gentle fall-off
      const h = Math.max(2, viz.levels[i] * (H * 0.46));
      const x = i * gap + (gap - bw) / 2;
      const warm = viz.levels[i];
      g.fillStyle = `rgba(${Math.round(120 + 131 * warm)}, ${Math.round(113 + 78 * warm)}, ${Math.round(108 - 72 * warm)}, ${0.25 + 0.6 * warm})`;
      g.beginPath();
      if (g.roundRect) g.roundRect(x, mid - h, bw, h * 2, bw / 2); else g.rect(x, mid - h, bw, h * 2);
      g.fill();
    }
  }

  async function setVizMode(on, fromUser = false, save = true) {
    if (on && fromUser) {
      const ok = await startAudioEngine();
      if (!ok) { toast(viz.error || 'Firefox didn\'t let the visualizer start its audio engine. Click Visualizer again.', true); on = false; save = false; }
    }
    vizMode = on;
    if (save) try { localStorage.setItem('spm-focus-view', on ? 'viz' : 'art'); } catch (e) { /* ignore */ }
    focusEl.classList.toggle('viz', on);
    $('.f-view').textContent = on ? 'Artwork' : 'Visualizer';
    if (on && !viz.raf && focus.on) drawViz();
  }
  $('.f-view').addEventListener('click', () => setVizMode(!vizMode, true));

  // Focus Mode keys (handled before anything else while it's open).
  function focusKeydown(e) {
    if (!focus.on) return false;
    wakeFocus();
    const onSlider = e.composedPath().some((el) => el.classList && el.classList.contains('f-vol'));
    if (e.key === 'Escape') exitFocus();
    else if (e.key === ' ' && !onSlider) focusToggle();
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !onSlider) setFocusVolume(focusVolume + (e.key === 'ArrowUp' ? 0.05 : -0.05));
    else if (e.key === 'v' || e.key === 'V') setVizMode(!vizMode, true);
    else return true; // swallow other keys so the overlay underneath doesn't react
    e.preventDefault();
    return true;
  }

  try { localStorage.removeItem('spm-gap'); } catch (e) { /* old toggle setting; no longer used */ }

  // ---------- staying in sync with Suno ----------
  // Select whatever you're looking at in Suno (a playlist or a song page).
  function syncFromPage() {
    const m = location.pathname.match(/^\/(playlist|song)\/([^/?#]+)/);
    if (!m || !state.loaded) return;
    if (m[1] === 'playlist') {
      const pl = state.playlists.find((p) => p.id === m[2]);
      if (pl && state.selectedPlaylist !== pl.id) { expandTo(normPath(pl.name)); selectPlaylist(pl.id); }
      return;
    }
    const id = m[2];
    if (!state.songs.some((s) => s.id === id)) return;
    if (!visibleSongs().some((s) => s.id === id)) { state.selectedPlaylist = '__all'; state.selection.clear(); }
    state.selection = new Set([id]);
    state.lastClicked = id;
    render();
    const row = songList.querySelector(`.song[data-id="${window.CSS && CSS.escape ? CSS.escape(id) : id}"]`);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
  }

  // Load every playlist's songs into a fresh map, then swap it in (no flashing).
  async function reloadAllMembersFor(playlists) {
    const members = new Map(), partial = new Map(), queue = playlists.map((p) => p.id);
    const worker = async () => {
      while (queue.length) {
        const pid = queue.shift();
        const pl = playlists.find((p) => p.id === pid);
        const { ids, expected } = await fetchPlaylistMembers(pid, pl ? pl.count : null);
        members.set(pid, ids);
        if (ids.size < expected) partial.set(pid, expected);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return { members, partial };
  }

  // Pick up changes made in Suno while the overlay was closed: playlists (new,
  // renamed, deleted, songs added/removed), new songs, and newly trashed songs.
  let refreshing = false;
  async function softRefresh() {
    if (!state.loaded || state.loading || refreshing) return;
    refreshing = true;
    const seq = state.editSeq;
    let again = false;
    status('Checking for changes in Suno…');
    try {
      const [playlists, newest, trashed] = await Promise.all([
        fetchPlaylists(),
        fetchLibrary(null, { maxPages: 1 }),
        fetchLibrary(null, { trashed: true, maxPages: 1 }),
      ]);
      const known = new Set(state.songs.map((s) => s.id));
      const added = newest.filter((s) => !known.has(s.id));
      if (added.length === newest.length && newest.length >= 50) { refreshing = false; return loadAll(); } // too much changed
      const { members, partial } = await reloadAllMembersFor(playlists);
      if (state.editSeq !== seq || state.busy) { again = true; return; } // you edited meanwhile: don't clobber it
      state.playlists = playlists;
      const gone = new Set(trashed.map((s) => s.id));
      state.songs = [...added, ...state.songs.filter((s) => !gone.has(s.id))];
      if (state.trash) state.trash = [...trashed.filter((s) => !state.trash.some((t) => t.id === s.id)), ...state.trash.filter((t) => !known.has(t.id) || gone.has(t.id))];
      state.members = members;
      state.partial = partial;
      state.allMembers = Promise.resolve();
      state.allMembersReady = true;
      state.allMembersError = null;
      [...state.selection].forEach((id) => { if (gone.has(id)) state.selection.delete(id); });
      if (!isSpecial(state.selectedPlaylist) && !playlists.some((p) => p.id === state.selectedPlaylist)) state.selectedPlaylist = '__all';
      status(`${plural(state.songs.length, 'song')} · ${plural(state.playlists.length, 'playlist')}`);
    } catch (e) {
      console.warn('[SPM] soft refresh failed:', e);
      status('Couldn\'t check for changes — use Refresh');
    } finally {
      refreshing = false;
      if (again) setTimeout(softRefresh, 1500);
      else { render(); syncFromPage(); }
    }
  }

  // Keep ♪ on whatever Suno's player is actually playing.
  let manualPlayAt = 0;
  function syncNowPlaying() {
    if (Date.now() - manualPlayAt < 4000) return; // give a just-clicked song time to start
    const np = nowPlaying();
    const id = np && np.key && state.songs.some((s) => s.id === np.key) ? np.key : null;
    if (id !== state.nowPlaying) { state.nowPlaying = id; updatePlayIcons(); }
  }

  // ---------- events ----------
  let closedAt = 0;
  function open() {
    overlay.classList.add('open');
    $('.fab').style.display = 'none';
    watchBar(true);
    if (!state.loaded) return loadAll();
    syncFromPage();
    syncNowPlaying();
    if (Date.now() - closedAt > 3000) softRefresh();
  }
  function close() {
    overlay.classList.remove('open');
    $('.fab').style.display = '';
    watchBar(false);
    closedAt = Date.now();
  }

  $('.fab').addEventListener('click', open);
  $('.close').addEventListener('click', close);
  $('.refresh').addEventListener('click', loadAll);
  document.addEventListener('keydown', (e) => {
    if (focusKeydown(e)) return;
    if (e.altKey && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP')) { e.preventDefault(); overlay.classList.contains('open') ? close() : open(); }
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
    if (e.key === 'Delete' && overlay.classList.contains('open') && state.selection.size && !inTrashView()
        && !e.composedPath().some((el) => el.tagName === 'INPUT')) { e.preventDefault(); doTrash([...state.selection]); }
  });

  $('.search').addEventListener('input', (e) => { state.query = e.target.value; renderSongs(); });
  $('.trash-sel').addEventListener('click', () => doTrash([...state.selection]));
  $('.play-pl').addEventListener('click', () => { if (!isSpecial(state.selectedPlaylist)) playPlaylistInSuno(state.selectedPlaylist); });
  $('.restore-sel').addEventListener('click', () => doRestoreFromTrash([...state.selection]));
  $('.remove-sel').addEventListener('click', () => {
    if (!isSpecial(state.selectedPlaylist)) doRemove(state.selectedPlaylist, [...state.selection]);
  });

  plList.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const path = toggle.dataset.toggle;
      collapsed.has(path) ? collapsed.delete(path) : collapsed.add(path);
      saveCollapsed();
      return renderPlaylists();
    }
    const add = e.target.closest('[data-addchild]');
    if (add) return createFlow([], `${add.dataset.addchild} / `);
    const row = e.target.closest('.pl');
    if (!row) return;
    if (row.dataset.pid === '__new') return createFlow();
    selectPlaylist(row.dataset.pid);
  });

  songList.addEventListener('click', (e) => {
    const row = e.target.closest('.song');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('[data-play]')) {
      e.stopPropagation();
      // Select it like a plain click (but never toggle it off).
      state.selection.clear();
      state.selection.add(id);
      state.lastClicked = id;
      renderSongs();
      return playInSuno(id);
    }
    if (e.target.closest('[data-remove]')) {
      e.stopPropagation();
      return doRemove(state.selectedPlaylist, [id]);
    }
    if (e.shiftKey && state.lastClicked) {
      const ids = visibleSongs().map((s) => s.id);
      const [a, b] = [ids.indexOf(state.lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
      if (a >= 0) ids.slice(a, b + 1).forEach((x) => state.selection.add(x));
    } else if (e.metaKey || e.ctrlKey) {
      state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id);
    } else {
      const only = state.selection.size === 1 && state.selection.has(id);
      state.selection.clear();
      if (!only) state.selection.add(id);
    }
    state.lastClicked = id;
    renderSongs();
  });

  songList.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.song');
    if (row && !e.target.closest('button') && !inTrashView()) playInSuno(row.dataset.id);
  });

  songList.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.song');
    if (!row) return;
    const id = row.dataset.id;
    if (!state.selection.has(id)) { state.selection.clear(); state.selection.add(id); renderSongs(); }
    const ids = [...state.selection];
    // Firefox needs setData() in dragstart to start a drag at all; a custom type
    // (no text/plain) keeps stray drops from being treated as text by the browser.
    e.dataTransfer.setData('application/x-spm-clips', JSON.stringify(ids));
    state.drag = { ids, rowId: id };
    e.dataTransfer.effectAllowed = 'copy';
    ghost.textContent = `${ids.length} song${ids.length > 1 ? 's' : ''}`;
    e.dataTransfer.setDragImage(ghost, 10, 10);
  });

  // Reorder: drag a song up/down within the open playlist.
  function clearDropMarks() { songList.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after')); }
  function dropPos(e, row) { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; } // true = after
  songList.addEventListener('dragover', (e) => {
    const row = e.target.closest('.song');
    if (!row || !state.drag || !canReorder() || row.dataset.id === state.drag.rowId) { clearDropMarks(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = dropPos(e, row);
    clearDropMarks();
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  songList.addEventListener('drop', (e) => {
    const row = e.target.closest('.song');
    clearDropMarks();
    if (!row || !state.drag || !canReorder()) return;
    e.preventDefault();
    if (state.drag.ids.length > 1) return toast('Reorder moves one song at a time — drag a single song.');
    doReorder(state.selectedPlaylist, state.drag.rowId, row.dataset.id, dropPos(e, row));
  });
  root.addEventListener('dragend', () => { state.drag = null; clearDropMarks(); });

  // Swallow drops anywhere else in the overlay so Firefox never acts on them.
  overlay.addEventListener('dragover', (e) => e.preventDefault());
  overlay.addEventListener('drop', (e) => e.preventDefault());

  const isDropTarget = (row) => row && !row.classList.contains('folder') && (!row.classList.contains('special') || row.dataset.pid === '__new');
  plList.addEventListener('dragover', (e) => {
    const row = e.target.closest('.pl');
    if (!isDropTarget(row)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    root.querySelectorAll('.pl.drop').forEach((r) => r !== row && r.classList.remove('drop'));
    row.classList.add('drop');
  });
  plList.addEventListener('dragleave', (e) => {
    const row = e.target.closest('.pl');
    if (row && !row.contains(e.relatedTarget)) row.classList.remove('drop');
  });
  plList.addEventListener('drop', (e) => {
    const row = e.target.closest('.pl');
    root.querySelectorAll('.pl.drop').forEach((r) => r.classList.remove('drop'));
    if (!isDropTarget(row)) return;
    e.preventDefault();
    let ids = [];
    try { ids = JSON.parse(e.dataTransfer.getData('application/x-spm-clips') || '[]'); } catch (err) { /* ignore */ }
    if (!ids.length) return;
    if (row.dataset.pid === '__new') createFlow(ids);
    else doAdd(row.dataset.pid, ids);
  });

  render();
})();
