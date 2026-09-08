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
- Shared playback uses native skip prompts, even if the account previously
  selected automatic skipping. That prevents a personal preference from seeking
  everyone else's playback. Remote player plugins and the group picker are not
  part of the Activity UI.
- The optional enable-playback button lives in the child frame so its click can
  satisfy mobile media gesture requirements. Its native `resumeGroupPlayback`
  call loads only this viewer's queue and changes their IgnoreWait setting; it
  does not send a shared Unpause command. The button disappears after a successful
  permission check or the media element's actual `playing` event. Native
  `playbackstart` fires during preparation and cannot prove autoplay succeeded.
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
