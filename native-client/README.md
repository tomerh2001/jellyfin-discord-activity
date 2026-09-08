# Native Jellyfin client

`node native-client/build.mjs` builds the actual Jellyfin Web 10.11.11 client.
Use Node22 with its npm10 and `tar`; no global npm installation is required.
The source commit, archive SHA256 and license are pinned in `upstream.json`.
The upstream npm lockfile supplies dependency integrity. Output goes to `dist/`
and is served by the Activity API at `/jellyfin-web/`.

The build applies a small integration patch before compiling the upstream source:

- A stable Discord parent frame provides a same-origin, source-checked bootstrap
  message. An unpredictable child nonce binds the response to the current frame.
- The native ApiClient receives an opaque gateway capability, account and device
  identity. Real Jellyfin credentials remain on the broker. Native credentials
  are held in memory and service-worker registration is disabled.
- A classic script runs before native modules and supplies separate in-memory
  localStorage/sessionStorage objects. Discord can deny the storage getters even
  on HTTPS. The optional CacheStorage response cache is disabled before its
  constructor runs. Browser preferences last for the current Activity document;
  saved server accounts remain on the broker.
- Native SyncPlay joins the Activity's mapped group after the WebSocket opens.
  Reconnection joins that same group. A socket outage lasting 40 seconds asks the
  parent for a fresh gateway launch, since disconnected capabilities expire.
  Native Jellyfin owns library browsing,
  episode queues, playback, audio, subtitles, quality and synchronization.
- If an accessible episode is absent from Jellyfin's expanded series response,
  playback keeps the originally selected episode rather than sending an empty
  queue. Other queue validation failures produce a native toast with fixed text;
  only the three known queue error codes on this frame's gateway are accepted.
- Shared playback uses native skip prompts, even if the account previously
  selected automatic skipping. That prevents a personal preference from seeking
  everyone else's playback. Remote player plugins and the group picker are not
  part of the Activity UI.
- A blocked media element exposes **Tap to play on this device** in the child
  frame. The click calls that exact element's `play()` before any asynchronous
  work; a temporary silent audio probe cannot grant a different video element
  WebKit playback permission. This never sends a shared Unpause command, and it
  restores a paused/stopped native group state after unlocking. The button stays
  available on failure and disappears when playback succeeds. Native
  `playbackstart` fires during preparation and cannot prove autoplay succeeded.
  The native video player's separate `unpause()` path also reports a rejected
  play attempt to the same recovery control.
- Native view navigation bubbles a custom `pagehide` from a DIV. It must not
  dispose document-wide adapter listeners. `onDocumentExit` accepts only a real
  window `PageTransitionEvent` with `persisted: false`; it does not use `once`,
  since a filtered custom event would still consume a once-only listener.
  Playback prompts, layout, queue feedback and video observers therefore survive
  ordinary Home-to-details navigation and back/forward-cache preservation.
- Discord's focused, picture-in-picture and grid layouts resize the existing
  player. Video previews hide library/navigation chrome. The layout event does
  not require another OAuth exchange or a replacement native frame. Standard
  browser fullscreen is requested directly from a user click; Discord's ancestor
  frame policy can refuse it, and the Activity cannot force the outer Discord
  application window into fullscreen. See [Discord layouts](https://docs.discord.com/developers/activities/development-guides/layout)
  and [fullscreen requirements](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).
- [HLS.js](https://github.com/video-dev/hls.js) 1.6.13 uses its lockfile-pinned
  standalone worker asset. Rebundling the default
  stringified worker factory can leave a webpack module reference outside its
  scope (`ReferenceError: e is not defined`) and silently fall back to main-thread
  processing. The unchanged worker and its Apache-2.0 license, including upstream
  copyright notices, are copied into the build.

The parent exchanges only bounded status messages after bootstrap. It never
receives native network logs, media URLs or credentials. Changing accounts
recreates the child, keeping the authenticated Discord SDK document alive.
Joining checks both the server URL and identity. Changing the shared server is a
separate confirmed action; other viewers detect the replacement and choose an
account for the new server.

For browser diagnostics, never print native network logs or raw gateway paths:
the `/jf/` path segment is a credential. A local HTTP smoke harness should first
load an actual response from the candidate origin before inserting its test
frame. Intercepting the top-level document with Playwright `route.fulfill` can
give Chromium the wrong address-space classification and trigger a misleading
private-network CORS error. Mobile viewport checks do not verify physical iOS or
Android media policies.

Jellyfin Web is GPL-2.0-or-later. The compiled output includes its license and
source metadata; this repository includes all modifications and the repeatable
source build. The upstream source is available at the pinned repository commit.

Run `node --test native-client/test/*.test.mjs` for the bootstrap trust-boundary
tests. Run the real native production build to verify patches against the pinned
upstream source; `--prepare-only` applies them without installing dependencies.
