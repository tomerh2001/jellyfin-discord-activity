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
- Native SyncPlay joins the Activity's mapped group after the WebSocket opens.
  Reconnection joins that same group. Native Jellyfin owns library browsing,
  episode queues, playback, audio, subtitles, quality and synchronization.
- Shared playback uses native skip prompts, even if the account previously
  selected automatic skipping. That prevents a personal preference from seeking
  everyone else's playback. Remote player plugins and the group picker are not
  part of the Activity UI.
- The optional enable-playback button lives in the child frame so its click can
  satisfy mobile media gesture requirements.

The parent exchanges only bounded status messages after bootstrap. It never
receives native network logs, media URLs or credentials. Changing accounts
recreates the child, keeping the authenticated Discord SDK document alive.

Jellyfin Web is GPL-2.0-or-later. The compiled output includes its license and
source metadata; this repository includes all modifications and the repeatable
source build. The upstream source is available at the pinned repository commit.

Run `node --test native-client/test/*.test.mjs` for the bootstrap trust-boundary
tests. Run the real native production build to verify patches against the pinned
upstream source; `--prepare-only` applies them without installing dependencies.
