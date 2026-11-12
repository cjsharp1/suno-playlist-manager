const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSuno, song } = require('./harness');

const A = song('A'), B = song('B'), C = song('C');

test('dragging songs onto a playlist adds them and updates Unsorted', async () => {
  const app = createSuno({ songs: [A, B, C], playlists: [{ id: 'p1', name: 'Focus', ids: [] }] });
  try {
    await app.open();
    await app.dragToPlaylist(['Song A', 'Song B'], 'p1');
    await app.waitFor(() => app.count('p1') === '2', { what: 'playlist count to update' });
    assert.deepEqual(app.server.playlists[0].ids, [A.id, B.id]);
    assert.equal(app.count('__unsorted'), '1');
    assert.match(app.row('Song A').textContent, /Focus/, 'song shows a tag for its playlist');
  } finally { app.close(); }
});

test('× removes a song from the open playlist', async () => {
  const app = createSuno({ songs: [A, B], playlists: [{ id: 'p1', name: 'Focus', ids: [A.id, B.id] }] });
  try {
    await app.open();
    await app.select('p1');
    app.row('Song A').querySelector('.x').click();
    await app.waitFor(() => app.titles().length === 1, { what: 'row to disappear' });
    await app.waitFor(() => app.server.playlists[0].ids.length === 1, { what: 'removal to reach Suno' });
    assert.deepEqual(app.server.playlists[0].ids, [B.id]);
    assert.equal(app.count('__unsorted'), '1');
  } finally { app.close(); }
});

test('dragging within a playlist reorders it', async () => {
  const app = createSuno({ songs: [A, B, C], playlists: [{ id: 'p1', name: 'Focus', ids: [A.id, B.id, C.id] }] });
  try {
    await app.open();
    await app.select('p1');
    await app.dragWithin('Song C', 'Song A', 'before');
    assert.deepEqual(app.titles(), ['Song C', 'Song A', 'Song B']);
    await app.waitFor(() => app.server.playlists[0].ids[0] === C.id, { what: 'reorder to reach Suno' });
    assert.deepEqual(app.server.playlists[0].ids, [C.id, A.id, B.id]);
  } finally { app.close(); }
});

test('dropping songs on "+ New playlist" creates a playlist containing them', async () => {
  const app = createSuno({ songs: [A, B] });
  try {
    app.window.prompt = () => 'Road Trip';
    await app.open();
    await app.dragToPlaylist(['Song B'], '__new');
    await app.waitFor(() => app.server.playlists.length === 1 && app.server.playlists[0].ids.length === 1, { what: 'playlist to be created' });
    assert.equal(app.server.playlists[0].name, 'Road Trip');
    assert.deepEqual(app.titles(), ['Song B']);
  } finally { app.close(); }
});

test('Delete moves songs to Trash; Undo restores them and their playlists', async () => {
  const app = createSuno({ songs: [A, B], playlists: [{ id: 'p1', name: 'Focus', ids: [A.id] }] });
  try {
    await app.open();
    app.row('Song A').click();
    app.$('.trash-sel').click();
    await app.waitFor(() => app.server.trash.length === 1, { what: 'song to reach Trash' });
    assert.deepEqual(app.titles(), ['Song B']);
    app.$('.toast-action').click();
    await app.waitFor(() => app.server.trash.length === 0, { what: 'undo' });
    assert.deepEqual(app.titles(), ['Song A', 'Song B']);
    assert.equal(app.count('p1'), '1');
  } finally { app.close(); }
});

test('Trash lists trashed songs, can restore them, and cannot play them', async () => {
  const app = createSuno({ songs: [A], trash: [B] });
  try {
    await app.open();
    await app.select('__trash');
    await app.waitFor(() => app.titles().length === 1, { what: 'Trash to load' });
    assert.deepEqual(app.titles(), ['Song B']);
    assert.equal(app.row('Song B').querySelector('.play').disabled, true);
    app.row('Song B').click();
    app.$('.restore-sel').click();
    await app.waitFor(() => app.server.trash.length === 0, { what: 'restore' });
    await app.select('__all');
    assert.deepEqual(app.titles().sort(), ['Song A', 'Song B']);
  } finally { app.close(); }
});
