const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSuno, song } = require('./harness');

const A = song('A');

async function inFocus(opts = {}) {
  const app = createSuno({ songs: [A], ...opts });
  await app.open();
  app.page.play(A.id);
  app.$('.focus-btn').click();
  return app;
}

test('shows the current song from the player bar', async () => {
  const app = await inFocus();
  try {
    await app.waitFor(() => app.$('.f-title').textContent === 'Song A', { what: 'title' });
    assert.equal(app.$('.f-tags').textContent, 'a style');
    assert.equal(app.$('.f-art').getAttribute('src'), `https://cdn.test/${A.id}-large.jpg`);
  } finally { app.close(); }
});

test('volume eases down to 25% on entry, holds against resets, and eases back on exit', async () => {
  const app = await inFocus();
  try {
    await app.sleep(1000);
    assert.ok(app.page.volume < 0.8 && app.page.volume > 0.25, `mid-fade, got ${app.page.volume}`);
    await app.waitFor(() => Math.abs(app.page.volume - 0.25) < 0.01, { what: 'fade to 25%' });
    app.document.getElementById('audio').volume = 0.8; // Suno resets volume on a new track
    assert.ok(Math.abs(app.page.volume - 0.25) < 0.01, 'reset is corrected');
    await app.waitFor(() => app.document.getElementById('bar-volume').value === '25', { what: "Suno's slider to sync when the fade ends" });
    app.key('Escape');
    await app.waitFor(() => app.document.getElementById('bar-volume').value === '80', { what: 'fade back to 80% to finish' });
    assert.equal(app.page.volume, 0.8);
    app.document.getElementById('audio').volume = 0.5;
    assert.equal(app.page.volume, 0.5, 'after exit, volume is left alone');
  } finally { app.close(); }
});

test('↑ stops the fade and is remembered for next time', async () => {
  const app = await inFocus();
  try {
    await app.sleep(500);
    app.key('ArrowUp');
    await app.sleep(100);
    const v = app.page.volume;
    await app.sleep(600);
    assert.equal(app.page.volume, v, 'no more fading after a manual change');
    assert.equal(app.window.localStorage.getItem('spm-focus-volume'), String(v));
  } finally { app.close(); }
});

test('shuffle and repeat press Suno\'s buttons and light up when on', async () => {
  const app = await inFocus();
  try {
    app.$('.f-shuffle').click();
    assert.equal(app.page.shuffle, true);
    await app.waitFor(() => app.$('.f-shuffle').classList.contains('on'), { what: 'shuffle to light up' });
    assert.ok(!app.$('.f-repeat').classList.contains('on'));
    app.key(' ');
    assert.ok(app.page.clicks.includes('bar:toggle'), 'Space presses play/pause');
    assert.equal(app.page.shuffle, true, 'Space does not touch shuffle');
  } finally { app.close(); }
});

test('visualizer routes audio analyser → speakers', async () => {
  const app = await inFocus();
  try {
    app.$('.f-view').click();
    await app.waitFor(() => app.wiring.includes('analyser→speakers'), { what: 'audio to be wired' });
    assert.ok(app.$('.focus').classList.contains('viz'));
    assert.equal(app.window.localStorage.getItem('spm-focus-view'), 'viz');
  } finally { app.close(); }
});

test('if the audio cannot be tapped, the visualizer falls back to artwork and leaves audio alone', async () => {
  const app = await inFocus({ audio: 'taken' });
  try {
    app.$('.f-view').click();
    await app.waitFor(() => !app.$('.focus').classList.contains('viz') && app.$('.toast').textContent, { what: 'fallback' });
    assert.deepEqual(app.wiring, []);
  } finally { app.close(); }
});
