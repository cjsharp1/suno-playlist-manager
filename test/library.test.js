const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSuno, song } = require('./harness');

const A = song('A'), B = song('B'), C = song('C'), D = song('D');

test('loads playlists and library; Unsorted is songs in no playlist', async () => {
  const app = createSuno({
    songs: [A, B, C, D],
    playlists: [{ id: 'p1', name: 'Focus', ids: [C.id, A.id] }, { id: 'p2', name: 'Chill', ids: [A.id] }],
  });
  try {
    await app.open();
    assert.equal(app.count('__all'), '4');
    assert.equal(app.count('__unsorted'), '2');
    assert.equal(app.count('p1'), '2');
    assert.deepEqual(app.titles(), ['Song A', 'Song B', 'Song C', 'Song D']);
    await app.select('__unsorted');
    assert.deepEqual(app.titles(), ['Song B', 'Song D']);
  } finally { app.close(); }
});

test('a playlist shows only its songs, in playlist order, and opens its Suno page', async () => {
  const app = createSuno({ songs: [A, B, C], playlists: [{ id: 'p1', name: 'Focus', ids: [C.id, A.id] }] });
  try {
    await app.open();
    await app.select('p1');
    assert.deepEqual(app.titles(), ['Song C', 'Song A']);
    await app.waitFor(() => app.window.location.pathname === '/playlist/p1', { what: 'Suno to open the playlist page' });
    assert.deepEqual(app.page.clicks, [], 'selecting a playlist must not start playback');
  } finally { app.close(); }
});

test('playlists over 50 songs load every page', async () => {
  const many = Array.from({ length: 72 }, (_, i) => song(`N${i}`));
  const app = createSuno({ songs: many, playlists: [{ id: 'big', name: 'Big', ids: many.map((s) => s.id) }] });
  try {
    await app.open();
    assert.equal(app.count('big'), '72');
    assert.equal(app.count('__unsorted'), '0');
    assert.ok(app.server.calls.some((c) => c.includes('/api/playlist/big/?page=2')), 'should request page 2');
  } finally { app.close(); }
});

test('library loads past the first 50 songs', async () => {
  const many = Array.from({ length: 120 }, (_, i) => song(`L${i}`));
  const app = createSuno({ songs: many });
  try {
    await app.open();
    assert.equal(app.count('__all'), '120');
  } finally { app.close(); }
});

test('"Parent / Child" names nest into folders; a folder shows its playlists combined', async () => {
  const app = createSuno({
    songs: [A, B, C, D],
    playlists: [
      { id: 'p1', name: 'Workout / Running', ids: [A.id, B.id] },
      { id: 'p2', name: 'Workout / Lifting', ids: [B.id, C.id] },
      { id: 'p3', name: 'AC/DC Hits', ids: [D.id] },
    ],
  });
  try {
    await app.open();
    const folder = app.$('.pl.folder');
    assert.equal(folder.querySelector('.name').textContent, 'Workout');
    assert.equal(folder.querySelector('.count').textContent, '3');
    assert.ok(app.$('.pl[data-pid="p3"]:not(.folder)'), '"AC/DC" has no spaced slash, so it stays a playlist');
    await app.select(folder.dataset.pid);
    assert.deepEqual(app.titles().sort(), ['Song A', 'Song B', 'Song C']);
    assert.equal(app.$$('.song .x').length, 0, 'folder view is read-only');
    app.$('.pl.folder .caret').click(); // re-query: selecting re-renders the list
    assert.ok(!app.$('.pl[data-pid="p1"]'), 'collapsing hides the children');
  } finally { app.close(); }
});
