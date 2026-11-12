# Suno Playlist Manager

A userscript that adds a playlist manager on top of [suno.com](https://suno.com). It shows your playlists and songs side by side, lets you drag songs into playlists, and makes it easy to see which songs aren't in any playlist yet. It also includes Focus Mode, a dark, distraction-free listening view.

> **Unofficial.** This isn't affiliated with or endorsed by Suno. Suno has no public API, so the script uses the same internal endpoints suno.com itself calls. When Suno changes those, parts of the script can break until it's updated. It only acts on your own account, using the session you're already signed in with.

## Install

1. Install a userscript manager: [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/). Both work in Firefox and Chrome.
2. Open **[suno-playlist-manager.user.js](https://raw.githubusercontent.com/cjsharp1/suno-playlist-manager/main/suno-playlist-manager.user.js)**. Your userscript manager recognizes the file and offers to install it.
3. Reload suno.com and sign in. A **♫ Playlists** button appears in the bottom-right corner.

Installed this way, your userscript manager checks this repo for new versions and updates the script automatically. The version number and changelog are at the top of the script.

## Using it

Open the manager with the **♫ Playlists** button or **Alt+P**. **Esc** closes it.

**Playlists (left panel)**
- **All songs**: your whole library.
- **Unsorted**: songs that aren't in any playlist.
- **Trash**: songs in Suno's Trash, with a **Restore** button.
- **Folders**: name playlists like `Workout / Running` and they nest under a "Workout" folder. Clicking a folder shows the songs from every playlist inside it. This only affects how the list is displayed. Suno still sees the full name.
- **+ New playlist**: click it to create a playlist, or drop songs on it to create one with those songs in it.

**Songs (right panel)**
- Click to select, Ctrl/Cmd-click to add to the selection, Shift-click to select a range.
- Drag songs onto a playlist to add them.
- Inside a playlist, drag a song up or down to reorder it. **×** removes a song from the playlist.
- **Delete** (or the Delete key) moves songs to Suno's Trash, with Undo.
- Each song shows tags for the playlists it's in. Hover over a song to see its full title and style.

**Playback**

Playback goes through Suno's own player, because Suno doesn't let other code play its audio directly.
- **▶** on a song plays it. Inside a playlist, Suno then continues through the rest of that playlist.
- **▶ Play playlist** plays the selected playlist.
- Selecting a playlist opens its page in Suno underneath the manager. Opening the manager selects whatever playlist or song you were viewing in Suno.

**Focus Mode**

Click **Focus** in the header to open a dark, full-screen view of the current song.
- Your volume eases down to 25% when you enter, or to the level you used last time. It eases back to where it was when you leave.
- Choose between the song's artwork and an audio visualizer.
- After a few seconds without mouse movement, everything except the visualizer fades out.

| Key | Action |
|---|---|
| Space | Play / pause |
| ↑ / ↓ | Volume ±5% |
| V | Artwork / visualizer |
| Esc | Leave Focus Mode |

## Limitations

- The library loads up to 5,000 songs.
- When you reopen the manager, it picks up changes you made in Suno: playlists, songs added or removed, new songs, and recently deleted songs. Older changes, such as an old song deleted in Suno, need **Refresh**.
- Folders and Unsorted exist only in this script. Suno has no equivalent.

## Development

The script runs as-is; there's no build step. Tests run it in [jsdom](https://github.com/jsdom/jsdom) against a fake Suno (Node 20+):

```sh
npm install
npm test
```

## Releasing a new version

Bump `@version` in the script header, add a changelog line, and push to `main`. Userscript managers only update when the version number goes up.

## Troubleshooting

Errors show up as a message at the bottom of the manager. More detail is in the browser console (F12), in lines starting with `[SPM]`. If something stops working after a Suno update, those console lines and any failed requests in the Network tab usually point to what changed.

## License

[MIT](LICENSE)
