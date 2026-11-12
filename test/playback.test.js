const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSuno, song } = require('./harness');

const A = song('A'), B = song('B'), C = song('C');
const playlists = [{ id: 'p1', name: 'Focus', ids: [A.id, B.id, C.id] }];

test('▶ outside a playlist plays the song from its own page and selects it', async () => {
  const app = createSuno({ songs: [A, B, C], playlists });
  try {
    await app.open();
    app.row('Song B').querySelector('.play').click();
    await app.waitFor(() => app.page.clicks.includes(`song:${B.id}`), { what: "Suno's song play button to be clicked" });
    assert.equal(app.window.location.pathname, `/song/${B.id}`);
    assert.ok(app.row('Song B').classList.contains('picked'));
    assert.ok(app.$('.overlay').classList.contains('open'), 'overlay stays open');
  } finally { app.close(); }
});

test('▶ inside a playlist clicks that row on the playlist page, so Suno continues the playlist', async () => {
  const app = createSuno({ songs: [A, B, C], playlists });
  try {
    await app.open();
    await app.select('p1');
    app.row('Song B').querySelector('.play').click();
    await app.waitFor(() => app.page.clicks.includes(`row:${B.id}`), { what: 'the hover-only row button to be clicked' });
    assert.equal(app.window.location.pathname, '/playlist/p1');
  } finally { app.close(); }
});

test('a song missing from the playlist page falls back to playing on its own', async () => {
  const app = createSuno({ songs: [A, B, C], playlists });
  try {
    app.page.unrendered = [C.id]; // e.g. a long list that hasn't rendered this row
    await app.open();
    await app.select('p1');
    app.row('Song C').querySelector('.play').click();
    await app.waitFor(() => app.page.clicks.includes(`song:${C.id}`), { timeout: 8000, what: 'fallback to the song page' });
    assert.match(app.$('.toast').textContent, /playing on its own/);
  } finally { app.close(); }
});

test('"Play playlist" clicks the playlist header button, not a track', async () => {
  const app = createSuno({ songs: [A, B, C], playlists });
  try {
    await app.open();
    await app.select('p1');
    assert.notEqual(app.$('.play-pl').style.display, 'none');
    app.$('.play-pl').click();
    await app.waitFor(() => app.page.clicks.includes('playlist:p1'), { what: 'header play button' });
    await app.select('__all');
    assert.equal(app.$('.play-pl').style.display, 'none', 'hidden outside real playlists');
  } finally { app.close(); }
});

test("♪ follows whatever Suno's player is playing", async () => {
  const app = createSuno({ songs: [A, B, C], playlists });
  try {
    await app.open();
    app.page.play(C.id); // e.g. Suno advanced to the next track on its own
    await app.waitFor(() => app.row('Song C').classList.contains('playing'), { timeout: 6000, what: '♪ to move' });
  } finally { app.close(); }
});
