# DoneBell

**Version 1.0.0** · A private, local completion sound for ChatGPT in Chrome.

DoneBell plays a sound when a response finishes on `https://chatgpt.com/`.
It requires Chrome 116 or newer and uses Manifest V3.

## Features

- Original Chime, synthesized locally with Web Audio.
- Select several sounds; each completion plays one selection at random.
- Import multiple MP3/WAV files, preview them, rename them, or remove them.
- Custom audio stays in local IndexedDB. Each file must decode, be at most
  10 MB, and last at most 15 seconds. Names can contain up to 60 characters.
- Adjustable volume and an on/off switch.
- **Background Only** skips the alert when the ChatGPT tab is the active tab
  in its window. This follows tab activity, not whether the Chrome window has focus.

## How notifications work

DoneBell watches the composer controls for an observed generation start and a
return to idle. It checks for thinking/background activity and waits for
1,200 ms of settled idle before sending one completion event. Manually pressing
Stop cancels the notification. Typing and opening an old conversation do not
start a completion cycle.

The content script sends a small internal message to the background worker,
which validates its sender and asks an offscreen document to play audio.
Duplicate events are suppressed, and completion sounds are queued. Previews
use the same player without creating completion events.

## Install from a release ZIP

1. Download `donebell-v1.0.0.zip` from the [v1.0.0 release](https://github.com/xafm/donebell/releases/tag/v1.0.0).
2. Extract it into a permanent folder. The manifest is at the extracted root.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select that extracted folder.
5. Open or reload ChatGPT, then pin DoneBell to use its popup.

Keep the extracted folder: Chrome loads the unpacked extension from it.

## Install from source

Use Node.js 24 or newer and npm.

```sh
git clone https://github.com/xafm/donebell.git
cd donebell
npm ci
npm run build:release
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
and select **`release/`** inside the project. Open or reload ChatGPT afterward.
The same command also creates `donebell-v1.0.0.zip` at the project root.
ZIP packaging requires the `zip` and `unzip` command-line tools.

After rebuilding, reload the extension in `chrome://extensions` and reload
ChatGPT. To preserve an existing local installation and its saved sounds,
continue loading it from its original `dist/` path; loading a different folder
may create a separate extension with separate local storage.

## Development and build modes

```sh
npm ci
npm run typecheck
npm run build                  # Local build → dist/
DONEBELL_DEBUG=1 npm run build # Local build with console diagnostics
npm run build:release         # Public build → release/ and versioned ZIP
```

Both builds use the same completion detector, popup, message validation,
background worker, offscreen player, and IndexedDB storage implementation.
No network permission is added. Builds check the manifest and complete
runtime file listing; the release command also inspects every ZIP entry and
compares its contents with the public build. Neither build runs tests.

| Build | Bundled sounds | Output behavior |
| --- | --- | --- |
| Local | Original Chime plus available MP3s listed in `assets/sounds/local-catalog.json` | Recreates `dist/`; honors `DONEBELL_DEBUG=1` |
| Public | Original Chime only; custom MP3/WAV import remains available | Recreates `release/` and ZIP; never touches `dist/`; diagnostics always disabled |

Optional local audio and its catalog belong only in the Git-ignored
`assets/sounds/` folder. The optional `local-catalog.json` is an array of objects
with exactly `id`, `name`, and `file` fields. IDs must be unique lowercase
letters/digits separated by single hyphens, start with a letter, and contain at
most 64 characters; `original` and `custom` are reserved. Names must be trimmed,
contain no control characters, and contain 1–80 characters. Filenames must be
unique lowercase letters/digits separated by single hyphens with an `.mp3`
extension and contain at most 128 characters. Paths and symlinks are rejected.
Keep existing IDs unchanged to preserve saved selections.

The local build copies available catalog files and omits missing audio from
its list. Without a catalog, it builds successfully with Original Chime alone.
Invalid catalogs fail the local build before replacing its output. The public
build never reads the catalog or local audio and ships Original Chime alone.
You can also import your own audio in the popup. Audio remains subject to its
own rights.

Saved sound IDs remain stable. If a stored built-in selection is unavailable
in a build, the popup and worker use the available selection, or show and use
Original Chime when none remains, without rewriting that stored selection
merely because the build changed. A broken bundled audio file reports playback
failure rather than playing Original Chime under another sound's label.

The SVG icon source is `assets/icons/icon.svg`; generated PNGs are committed,
so ordinary builds do not require an image renderer. To regenerate them with
[librsvg](https://gitlab.gnome.org/GNOME/librsvg):

```sh
for size in 16 32 48 128; do
  rsvg-convert --width "$size" --height "$size" --output "assets/icons/icon${size}.png" assets/icons/icon.svg
done
```

## Privacy and permissions

DoneBell makes no network requests, uses no analytics, and does not read,
store, or upload prompt or response text. It observes UI controls and activity
attributes. Settings stay in `chrome.storage.local`; imported audio and its
name stay in extension-origin IndexedDB. Internal completion messages contain
a random cycle ID, with browser tab/document identity added by the worker.

The only permissions are **storage** for preferences and **offscreen** for
audio. The content script runs only on `https://chatgpt.com/*`, in the top
frame. The extension's content security policy blocks network connections.
Local debug builds log diagnostic stages to the console without conversation
text; public builds always disable those diagnostics.

## Known limitations

- Detection depends on ChatGPT's page structure, not an official completion
  API. Layout or language changes can require an extension update.
- Unrecognized thinking/background indicators can cause an early alert;
  unknown errors may look like a successful completion.
- Chrome can delay background timers. Frozen, discarded, closed, or suspended
  pages cannot reliably report completion.
- Audio depends on Chrome autoplay policy, device settings, and OS volume.
  Preview a sound to check playback. Ambiguous delivery failures are not
  retried, to avoid duplicate sounds.
- Completion deduplication is bounded and lasts for the offscreen document's
  lifetime; this is not a durable notification queue.
- No automated tests or browser automation were run for release preparation.
  Static checks do not verify live ChatGPT DOM behavior or audible output.

## Licensing and attribution

DoneBell's composer recognition follows the
[Chat Dinger](https://github.com/rumblelab/chatdinger) detection approach.
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) preserves its verified upstream
MIT copyright and permission notice. This notice and [LICENSE](LICENSE)
are included in the extension ZIP.
Build dependencies are development-only; no npm runtime packages are bundled.

DoneBell's original code, including the synthesized Original Chime, and
project-created artwork are licensed under the [MIT License](LICENSE).
Copyright (c) 2026 Faruk (xafm). The upstream MIT terms and attribution also
apply to the Chat Dinger-derived portions.

Third-party and user-provided media are excluded from DoneBell's license.
Optional local game audio and `local-catalog.json` remain private and are
excluded from the public repository and release ZIP. Imported audio remains
local and subject to its own rights.

DoneBell is an independent project, not affiliated with or endorsed by OpenAI.
Product names belong to their respective owners.
