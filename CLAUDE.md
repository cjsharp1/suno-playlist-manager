# Suno Playlist Manager

A single-file userscript, `suno-playlist-manager.user.js`, for suno.com. The owner runs it in Firefox through Violentmonkey, installed from the raw file on `main`, so every push to `main` that changes the script is a release.

## Releasing

1. Bump `@version` in the script header. Installed copies only update when the version goes up. Patch for fixes, minor for features.
2. Add a one-line entry at the top of the `// Changelog` block. Keep it condensed: one entry per minor version (`0.14.x`), with fixes folded into their feature's line.
3. Update `README.md` when user-visible behavior changes.

## Suno internals

Suno has no public API. The script calls the same endpoints suno.com does (`studio-api-prod.suno.com`), so expect them to drift.

- **Auth**: a Clerk JWT from `Clerk.session.getToken()`. In Firefox, page globals such as `Clerk` and `next` are reached through `window.wrappedJSObject` (see `pageWin`).
- **Playback**: since Oct 2026 Suno encrypts streamed audio. `audio_url` comes back as `/api/forbidden`, and the CDN mp3/mp4 files are blocked. Playback goes through Suno's own player: navigate with `next.router.push` (no reload, so the overlay survives), then click Suno's play button. Keep it that way rather than working around the encryption.
- **Playlist songs** come 50 per page: `/api/playlist/{id}/?page=N`.
- **Player bar** buttons have labels starting with `Playbar:`. Shuffle and repeat carry `data-inactive=""` while off.
- **Layout cost**: locating the player bar forces a layout of Suno's heavy page. `findPlayerBar()` caches it. Keep anything that runs per tick or per frame on the cached lookup, because uncached lookups caused visualizer hitches.
- **Folders** exist only in the script. They come from playlist names split on ` / ` (space, slash, space).

## Verifying changes

Run `npm test` (after `npm install`). It runs the script in jsdom against a fake Suno defined in `test/harness.js`: the API, the song and playlist pages, and the player bar. Every change gets a test in the matching `test/*.test.js` file, and the suite stays green before pushing.

The fake is our model of the real suno.com, so it can be wrong. When the script relies on something new about Suno's page, add it to the harness and name it as an assumption in your report. When the owner finds that real Suno behaves differently, fix the harness to match first, then fix the script. Final confirmation is the owner testing on suno.com in Firefox.

Open questions and planned features are tracked as GitHub issues.
