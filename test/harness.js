// Test harness: runs the userscript in jsdom against a fake Suno.
//
// The fake encodes what we believe about the real suno.com: API shapes, page
// structure, player-bar markup. When the real site disagrees, fix the fake to
// match reality first, then fix the script.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'suno-playlist-manager.user.js'), 'utf8');
const API = 'https://studio-api-prod.suno.com';
const VW = 1000, VH = 800, BAR_H = 78;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build songs quickly: song('A') → { id: 'sA', title: 'Song A', ... }
function song(name, extra = {}) {
  return { id: `s${name}`, title: `Song ${name}`, tags: `${name.toLowerCase()} style`, created: '2026-10-01T00:00:00Z', ...extra };
}

function toClip(s) {
  return { id: s.id, title: s.title, created_at: s.created, image_url: `https://cdn.test/${s.id}.jpg`,
    image_large_url: `https://cdn.test/${s.id}-large.jpg`, audio_url: 'https://studio-api.prod.suno.com/api/forbidden',
    metadata: { tags: s.tags, duration: 180 } };
}

// ---------------------------------------------------------------------------
// Fake Suno API. `songs`, `trash`, and `playlists` are live and can be mutated
// by tests to simulate changes made in Suno's own UI.
// ---------------------------------------------------------------------------
function createServer({ songs = [], trash = [], playlists = [] } = {}) {
  const server = { songs: [...songs], trash: [...trash], playlists: playlists.map((p) => ({ ...p, ids: [...p.ids] })), calls: [] };
  let nextId = 1;
  const find = (id) => server.playlists.find((p) => p.id === id);
  const page = (list, n, size) => list.slice((n - 1) * size, n * size);

  server.handle = (method, pathAndQuery, body) => {
    const url = new URL(pathAndQuery, API);
    const p = url.pathname;
    const pageNo = +(url.searchParams.get('page') || 1);
    if (method !== 'GET' || p !== '/api/feed/v3') server.calls.push(`${method} ${pathAndQuery}${body ? ` ${JSON.stringify(body)}` : ''}`);
    let m;

    if (method === 'POST' && p === '/api/feed/v3') {
      const list = body.filters.trashed === 'True' ? server.trash : server.songs;
      const start = +(body.cursor || 0), size = body.limit || 50;
      const next = start + size;
      return { clips: list.slice(start, next).map(toClip), has_more: next < list.length, next_cursor: next < list.length ? String(next) : null };
    }
    if (method === 'GET' && p === '/api/playlist/me') {
      return { num_total_results: server.playlists.length,
        playlists: page(server.playlists, pageNo, 20).map((pl) => ({ id: pl.id, name: pl.name, song_count: pl.ids.length })) };
    }
    if (method === 'GET' && (m = p.match(/^\/api\/playlist\/([^/]+)\/$/))) {
      const pl = find(m[1]);
      return { id: pl.id, name: pl.name, num_total_results: pl.ids.length,
        playlist_clips: page(pl.ids, pageNo, 50).map((id) => ({ clip: { id } })) };
    }
    if (method === 'GET' && p.startsWith('/api/playlist/v2/')) return { id: p.split('/').pop() }; // metadata only, like the real one
    if (method === 'POST' && p === '/api/playlist/create/') {
      const pl = { id: `pNew${nextId++}`, name: body.name, ids: [] };
      server.playlists.unshift(pl);
      return { id: pl.id, name: pl.name };
    }
    if (method === 'POST' && (m = p.match(/^\/api\/playlist\/v2\/([^/]+)\/tracks\/(add|remove|reorder-by-index)$/))) {
      const pl = find(m[1]);
      if (m[2] === 'add') body.clip_ids.forEach((id) => { if (!pl.ids.includes(id)) pl.ids.push(id); });
      if (m[2] === 'remove') pl.ids = pl.ids.filter((id) => !body.clip_ids.includes(id));
      if (m[2] === 'reorder-by-index') body.positions.forEach(({ clip_id, index }) => {
        pl.ids = pl.ids.filter((id) => id !== clip_id);
        pl.ids.splice(index, 0, clip_id);
      });
      return {};
    }
    if (method === 'POST' && p === '/api/gen/trash') {
      const [from, to] = body.trash ? ['songs', 'trash'] : ['trash', 'songs'];
      const moving = server[from].filter((s) => body.clip_ids.includes(s.id));
      server[from] = server[from].filter((s) => !body.clip_ids.includes(s.id));
      server[to] = [...moving, ...server[to]];
      return {};
    }
    throw new Error(`Fake Suno has no handler for ${method} ${pathAndQuery}`);
  };
  return server;
}

// ---------------------------------------------------------------------------
// Fake suno.com pages and player bar.
// ---------------------------------------------------------------------------
function installPage(w, server) {
  const d = w.document;
  const page = { clicks: [], nowPlaying: null, playing: false, shuffle: false, repeat: false, volume: 0.8, barVisible: false };
  d.body.innerHTML = `<main id="main"></main>
    <div id="bar" style="position:fixed;bottom:0;left:0;right:0" hidden>
      <img id="bar-art" alt=""><a id="bar-link" href="#"></a>
      <button aria-label="Playbar: Toggle shuffle button" data-inactive="" id="bar-shuffle">s</button>
      <button aria-label="Playbar: Previous button">p</button>
      <button aria-label="Playbar: Pause button" id="bar-toggle">t</button>
      <button aria-label="Playbar: Next button">n</button>
      <button aria-label="Playbar: Toggle repeat button" data-inactive="" id="bar-repeat">r</button>
      <input type="range" aria-label="Volume" min="0" max="100" value="80" id="bar-volume">
    </div>
    <audio id="audio"></audio>`;
  const $ = (id) => d.getElementById(id);

  // Audio element: volume/paused/time are plain values tests can inspect.
  const audio = $('audio');
  Object.defineProperty(audio, 'volume', { get: () => page.volume, set: (v) => { page.volume = v; audio.dispatchEvent(new w.Event('volumechange')); } });
  Object.defineProperty(audio, 'paused', { get: () => !page.playing });
  Object.defineProperty(audio, 'duration', { get: () => 180 });
  Object.defineProperty(audio, 'currentTime', { get: () => 60 });
  Object.defineProperty(audio, 'currentSrc', { get: () => (page.nowPlaying ? 'blob:suno' : '') });
  $('bar-volume').addEventListener('input', (e) => { audio.volume = +e.target.value / 100; });

  page.play = (id) => {
    const s = server.songs.find((x) => x.id === id);
    page.nowPlaying = id;
    page.playing = true;
    page.barVisible = true;
    $('bar').hidden = false;
    $('bar-link').setAttribute('href', `/song/${id}`);
    $('bar-link').textContent = s ? s.title : id;
    $('bar-art').setAttribute('alt', s ? s.title : id);
    $('bar-art').setAttribute('src', `https://cdn.test/${id}.jpg`);
  };
  const record = (what, fn) => (e) => { page.clicks.push(what); if (fn) fn(e); };
  $('bar-toggle').addEventListener('click', record('bar:toggle', () => { page.playing = !page.playing; }));
  [['bar-shuffle', 'shuffle'], ['bar-repeat', 'repeat']].forEach(([id, key]) => $(id).addEventListener('click', record(`bar:${key}`, () => {
    page[key] = !page[key];
    page[key] ? $(id).removeAttribute('data-inactive') : $(id).setAttribute('data-inactive', '');
  })));

  // Pages. Playlist rows only render their play button on hover, like many track lists.
  page.render = (pathname) => {
    const main = $('main');
    if (!main) return; // window already closed
    let m;
    if ((m = pathname.match(/^\/playlist\/([^/]+)/))) {
      const pl = server.playlists.find((p) => p.id === m[1]);
      if (!pl) { main.innerHTML = '<h1>Not found</h1>'; return; }
      main.innerHTML = `<h1>${pl.name}</h1><button aria-label="Play playlist" data-size="56" id="pl-play">▶</button>` +
        pl.ids.filter((id) => !(page.unrendered || []).includes(id))
          .map((id) => `<div class="row" data-id="${id}"><a href="/song/${id}">${(server.songs.find((s) => s.id === id) || {}).title || id}</a></div>`).join('');
      $('pl-play').addEventListener('click', record(`playlist:${pl.id}`, () => page.play(pl.ids[0])));
      main.querySelectorAll('.row').forEach((row) => row.addEventListener('mouseenter', () => {
        if (row.querySelector('button')) return;
        row.insertAdjacentHTML('beforeend', '<button aria-label="Play">▶</button>');
        row.querySelector('button').addEventListener('click', record(`row:${row.dataset.id}`, () => page.play(row.dataset.id)));
      }));
    } else if ((m = pathname.match(/^\/song\/([^/]+)/))) {
      const s = server.songs.find((x) => x.id === m[1]);
      main.innerHTML = `<h1>${s ? s.title : m[1]}</h1><button aria-label="Play Song" id="song-play">▶</button>`;
      $('song-play').addEventListener('click', record(`song:${m[1]}`, () => page.play(m[1])));
    } else {
      main.innerHTML = '<h1>Library</h1>';
    }
  };

  // Suno's Next.js router: client-side navigation, no reload.
  w.next = { router: { push: (p) => { w.history.pushState({}, '', p); setTimeout(() => page.render(p), 20); } } };
  page.render(w.location.pathname);
  return page;
}

// jsdom has no layout engine: give the player bar a real-looking box and make
// everything visible.
function installLayout(w, page) {
  const d = w.document;
  Object.defineProperty(w, 'innerWidth', { value: VW, configurable: true });
  Object.defineProperty(w, 'innerHeight', { value: VH, configurable: true });
  w.Element.prototype.getClientRects = function () { return [1]; };
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.id === 'bar') return { top: VH - BAR_H, bottom: VH, left: 0, width: VW, height: BAR_H };
    const s = +(this.dataset && this.dataset.size) || 40;
    return { top: 0, bottom: s, left: 0, width: s, height: s };
  };
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 520; }, configurable: true }); // visualizer canvas
  Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 300; }, configurable: true });
  d.elementsFromPoint = () => (page.barVisible ? [d.getElementById('bar-toggle'), d.getElementById('bar'), d.body, d.documentElement]
    : [d.getElementById('main'), d.body, d.documentElement]);
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
}

// Fake Web Audio. mode: 'ok' | 'taken' (Suno's audio is already routed elsewhere).
function installAudio(w, mode) {
  const wiring = [];
  w.AudioContext = class {
    constructor() { this.state = 'suspended'; this.destination = { name: 'speakers' }; }
    async resume() { this.state = 'running'; }
    createMediaElementSource() {
      if (mode === 'taken') throw new Error('InvalidStateError: already connected');
      return { name: 'audio', connect: (n) => wiring.push(`audio→${n.name}`) };
    }
    createAnalyser() {
      return { name: 'analyser', frequencyBinCount: 256, connect: (n) => wiring.push(`analyser→${n.name}`), getByteFrequencyData: (a) => a.fill(128) };
    }
  };
  return wiring;
}

// ---------------------------------------------------------------------------
// createSuno(): a page with the userscript running. Call close() when done.
// ---------------------------------------------------------------------------
function createSuno({ songs, trash, playlists, url = 'https://suno.com/me', audio = 'ok', storage = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
  const server = createServer({ songs, trash, playlists });
  const page = installPage(w, server);
  installLayout(w, page);
  const wiring = installAudio(w, audio);
  w.Clerk = { session: { getToken: async () => 'test-jwt' } };
  w.confirm = () => true;
  w.prompt = () => null;
  w.open = (u) => { page.clicks.push(`window.open:${u}`); return {}; };
  w.fetch = async (u, opts = {}) => {
    const p = u.replace(API, '');
    try {
      const body = server.handle(opts.method || 'GET', p, opts.body ? JSON.parse(opts.body) : null);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    } catch (e) {
      return { ok: false, status: 404, text: async () => e.message };
    }
  };
  w.eval(SCRIPT);
  const root = d.getElementById('spm-host').shadowRoot;

  const app = {
    window: w, document: d, root, server, page, wiring,
    $: (q) => root.querySelector(q),
    $$: (q) => [...root.querySelectorAll(q)],
    sleep,
    async waitFor(fn, { timeout = 4000, what = 'condition' } = {}) {
      const until = Date.now() + timeout;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
        await sleep(25);
      }
    },
    // Open the overlay and wait for the library and every playlist's songs.
    async open() {
      app.$('.fab').click();
      await app.waitFor(() => !app.$('.status').textContent.startsWith('Loading') && app.$('.pl[data-pid="__unsorted"] .count')
        && /^\d+$/.test(app.$('.pl[data-pid="__unsorted"] .count').textContent), { what: 'library to load' });
    },
    close() { w.close(); },
    key(k, opts = {}) { d.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts })); },
    click(el, opts = {}) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true, ...opts })); },
    // Song titles currently listed in the right panel.
    titles: () => app.$$('.song .title').map((e) => e.textContent),
    row: (title) => app.$$('.song').find((r) => r.querySelector('.title').textContent === title),
    count: (pid) => app.$(`.pl[data-pid="${pid}"] .count`).textContent,
    async select(pid) {
      app.$(`.pl[data-pid="${pid}"]`).click();
      await app.waitFor(() => !app.$('.songs .empty') || !/Loading/.test(app.$('.songs .empty').textContent), { what: `${pid} to load` });
    },
    // Drag songs (by title) onto a playlist row in the left panel.
    async dragToPlaylist(titlesToDrag, pid) {
      const ids = titlesToDrag.map((t) => app.row(t).dataset.id);
      const dt = { setData() {}, setDragImage() {}, getData: () => JSON.stringify(ids), effectAllowed: '', dropEffect: '' };
      const start = new w.Event('dragstart', { bubbles: true, composed: true });
      start.dataTransfer = dt;
      app.row(titlesToDrag[0]).dispatchEvent(start);
      const drop = new w.Event('drop', { bubbles: true, cancelable: true, composed: true });
      drop.dataTransfer = dt;
      app.$(`.pl[data-pid="${pid}"]`).dispatchEvent(drop);
      app.root.dispatchEvent(new w.Event('dragend', { bubbles: true }));
      await sleep(50);
    },
    // Drag one song before/after another inside the open playlist.
    async dragWithin(title, targetTitle, where) {
      const dt = { setData() {}, setDragImage() {}, getData: () => '', effectAllowed: '', dropEffect: '' };
      const ev = (type, extra) => { const e = new w.Event(type, { bubbles: true, cancelable: true, composed: true }); e.dataTransfer = dt; Object.assign(e, extra); return e; };
      app.row(title).dispatchEvent(ev('dragstart'));
      const clientY = where === 'before' ? 5 : 35;
      app.row(targetTitle).dispatchEvent(ev('dragover', { clientY }));
      app.row(targetTitle).dispatchEvent(ev('drop', { clientY }));
      app.root.dispatchEvent(new w.Event('dragend', { bubbles: true }));
      await sleep(50);
    },
  };
  return app;
}

module.exports = { createSuno, song };
