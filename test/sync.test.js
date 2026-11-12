const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSuno, song } = require('./harness');

const A = song('A'), B = song('B'), C = song('C');

test('opening the overlay selects the playlist you are viewing in Suno', async () => {
  const app = createSuno({ songs: [A, B], playlists: [{ id: 'p1', name: 'Focus', ids: [A.id] }, { id: 'p2', name: 'Chill', ids: [B.id] }], url: 'https://suno.com/playlist/p2' });
  try {
    await app.open();
    await app.waitFor(() => app.$('.pl.sel') && app.$('.pl.sel').dataset.pid === 'p2', { what: 'Chill to be selected' });
    assert.deepEqual(app.titles(), ['Song B']);
  } finally { app.close(); }
});

test('opening the overlay on a song page selects that song', async () => {
  const app = createSuno({ songs: [A, B, C], url: `https://suno.com/song/${B.id}` });
  try {
    await app.open();
    await app.waitFor(() => app.row('Song B').classList.contains('picked'), { what: 'Song B to be selected' });
  } finally { app.close(); }
});

test('reopening picks up changes made in Suno while the overlay was closed', async () => {
  const app = createSuno({ songs: [A, B], playlists: [{ id: 'p1', name: 'Focus', ids: [A.id] }] });
  try {
    await app.open();
    app.$('.close').click();
    // Changes made in Suno's own UI:
    app.server.playlists[0].name = 'Focus Mix';
    app.server.playlists[0].ids.push(B.id);
    app.server.playlists.push({ id: 'p2', name: 'New One', ids: [] });
    app.server.songs.unshift(C);
    await app.sleep(3100); // reopening within 3 s skips the re-check
    app.$('.fab').click();
    await app.waitFor(() => app.$('.pl[data-pid="p2"]') && app.count('p1') === '2', { what: 'changes to appear' });
    assert.equal(app.$('.pl[data-pid="p1"] .name').textContent, 'Focus Mix');
    assert.equal(app.count('__all'), '3');
    assert.equal(app.count('__unsorted'), '1');
  } finally { app.close(); }
});
