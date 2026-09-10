# Native Jellyfin client

`node native-client/build.mjs` builds the actual Jellyfin Web 12.0.0 client.
Use Node24 with npm11 or newer and `tar`; no global npm installation is required.
The source commit, archive SHA256 and license are pinned in `upstream.json`.
The upstream npm lockfile supplies dependency integrity. Output goes to `dist/`
and the Activity API serves its `index.html` at the mapped origin's root.
The native HashRouter owns navigation within the Activity document.

The build applies a small integration patch before compiling the upstream source:

- Jellyfin 12's upstream **Modern** application supplies the responsive desktop
  and mobile interface. The app selects its native desktop/mobile mode before
  the router initializes, so a stored display preference cannot select the old
  application. The old layout selector is removed from Modern preferences.
  Modern's own video page combines its MUI toolbar with Jellyfin's shared video
  controller; seek previews, fullscreen and SyncPlay extend that same player.
  There is no iframe or separate playback interface.

- The native document loads the [session library](../apps/activity-web/README.md)
  once, before the adapter initializes. That library supplies Discord SDK
  authentication and the broker API without rendering a separate interface.
  In a Discord frame it starts the existing deduplicated authentication flow
  immediately, overlapping native parsing and translation loading. Native
  initialization awaits that same session, selects the Jellyfin connection,
  and then renders the native application.
- Both legacy settings and the React configuration provider use the configuration
  packaged in the same build. They do not fetch `config.json` again at startup.
  Configuration changes therefore require a new native build and release.
- The Modern toolbar's MUI SyncPlay button, also used by its video OSD,
  opens **Watch party** only when clicked. It shows the people in the current
  Discord Activity, their display names and avatars, and identifies the current
  viewer as **You**. The only action is **Close**. Fullscreen stays with Jellyfin's
  player controls. The roster uses the Embedded App SDK's
  `getActivityInstanceConnectedParticipants` snapshot and
  `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` events; an existing unused getter alone
  did not render any participants. A newer push wins over an older pending
  snapshot so a departed person cannot reappear. Opening the panel refreshes
  its data without another OAuth exchange or background polling. Names are
  rendered as text and avatar paths contain only validated Discord IDs/hashes.
  This is Activity presence, not proof of Jellyfin authentication, playback
  readiness or authorization; server-side membership and account checks remain
  independent. SDK errors retain the last roster with an explicit warning.
- First use renders Jellyfin's own login page and native form controls inside
  the Modern app. The form adds the server URL and an explicit **Sign in as
  community user** button where configured. Personal credentials go to the
  broker, which keeps only the encrypted Jellyfin token. No login happens from
  a single saved account unless the user previously selected that preference.
  Subsequent launches restore that choice. The native **Sign out** action
  deletes the selected saved connection, revokes its viewer capabilities and
  returns to login; it keeps the Discord session and other viewers connected.
  Every successful personal or community login installs a fresh native client
  and automatically joins the current Activity party after its socket opens.
  Bootstrap can render login before an ApiClient exists; SyncPlay initializes
  on the first authenticated client, then updates on later account changes.
- The native ApiClient receives an opaque gateway capability, account and device
  identity. Real Jellyfin credentials remain on the broker. Native credentials
  are held in memory and service-worker registration is disabled.
- A classic script runs before native modules and supplies separate in-memory
  localStorage/sessionStorage objects. Discord can deny the storage getters even
  on HTTPS. The optional CacheStorage response cache is disabled before its
  constructor runs. Browser preferences last for the current Activity document;
  saved server accounts remain on the broker.
  Jellyfin 12's IndexedDB query persistence is also removed: the native root uses
  an in-memory QueryClientProvider, and its query module has no IndexedDB
  persister. Account replacement clears that document's query cache.
- Jellyfin 12's SDK subscriptions own one WebSocket per native ApiClient. The
  adapter bridges its status to the legacy player lifecycle methods used by
  SyncPlay and the Activity, without opening a second connection. Identical
  authentication metadata does not reconnect an unchanged capability. SDK and
  legacy subscribers share account ownership checks; unsubscribe, client close
  and replacement suppress late callbacks, and close disables SDK reconnection.
- Native SyncPlay joins the Activity's mapped group after the WebSocket opens.
  Reconnection joins that same group. A socket outage lasting 40 seconds asks the
  document's controller for a fresh gateway launch, since disconnected
  capabilities expire.
  Native Jellyfin owns library browsing,
  episode queues, playback, audio, subtitles, quality and synchronization.
- If an accessible episode is absent from Jellyfin's expanded series response,
  playback keeps the originally selected episode rather than sending an empty
  queue. Other queue validation failures produce a native toast with fixed text;
  only the three known queue error codes on the active gateway are accepted.
- Shared playback uses native skip prompts, even if the account previously
  selected automatic skipping. That prevents a personal preference from seeking
  everyone else's playback. Remote player plugins and the group picker are not
  part of the Activity UI. The shared Modern SyncPlay button does not load or
  expose arbitrary server groups; the verified Discord party owns membership.
  Modern toolbar and video controls omit the unsupported remote-player button.
- A blocked media element opens a native **Join playback** dialog containing
  **Tap to play on this device**. The click calls that exact element's `play()` before any asynchronous
  work; a temporary silent audio probe cannot grant a different video element
  WebKit playback permission. This never sends a shared Unpause command, and it
  restores a paused/stopped native group state after unlocking. The button stays
  available on failure and disappears when playback succeeds. Native
  `playbackstart` fires during preparation and cannot prove autoplay succeeded.
  The native video player's separate `unpause()` path also reports a rejected
  play attempt to the same recovery control. Stop and account replacement
  explicitly reset that prompt and invalidate pending play attempts. Native
  destruction can detach the video before its queued `emptied` event reaches
  the document, so listening for `emptied` alone is insufficient.
- Native view navigation bubbles a custom `pagehide` from a DIV. It must not
  dispose document-wide adapter listeners. `onDocumentExit` accepts only a real
  window `PageTransitionEvent` with `persisted: false`; it does not use `once`,
  since a filtered custom event would still consume a once-only listener.
  Playback prompts, layout, queue feedback and video observers therefore survive
  ordinary Home-to-details navigation and back/forward-cache preservation.
- Discord's focused, picture-in-picture and grid layouts resize the existing
  player. Video previews hide library/navigation chrome. The layout event does
  not require another OAuth exchange or a new document. Jellyfin's standard
  fullscreen button, F shortcut and double-click synchronously request document
  fullscreen, keeping Jellyfin's OSD and subtitle overlays visible. Where only
  Safari video fullscreen is available, the native player uses its exact video
  element and tracks that element's fullscreen entry/exit events. Those listeners
  are removed with the player. Unsupported requests and synchronous/asynchronous
  refusals show fixed native toast feedback without changing playback or SyncPlay.
  Discord's embedding policy can refuse fullscreen, and the Activity cannot force
  the outer Discord application window into fullscreen. SDK 2.5.0 has no command
  to override that policy. See [Discord SDK commands](https://github.com/discord/embedded-app-sdk/blob/v2.5.0/src/commands/index.ts),
  [Discord layouts](https://docs.discord.com/developers/activities/development-guides/layout)
  and [fullscreen requirements](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).
- Discord can replace the entire document when popping an Activity out or back
  in, and can assign a new instance ID if the Activity was otherwise empty
  ([upstream report](https://github.com/discord/embedded-app-sdk/issues/202)).
  Fresh documents authenticate normally, recover the saved account, and restore
  the last allowed browsing route from a short-lived server checkpoint. Native
  SyncPlay supplies the queue, position and paused/playing state. Within the
  same document, account reconnection retains the current browsing route; an
  explicit account change starts at that account's Home.
  Checkpoints are saved on native navigation, renewed while watching, and flushed
  with keepalive on real document exit. They contain no tokens or playback commands.
  A new verified instance can reclaim one recently disconnected group only for
  the same user, connection, server and guild/channel, with no connected viewers.
  Old capabilities are revoked. Sign out or account removal invalidates
  restoration. The Activity cannot suppress Discord's own refresh prompt.
- [HLS.js](https://github.com/video-dev/hls.js) 1.6.16 uses its lockfile-pinned
  standalone worker asset. Rebundling the default
  stringified worker factory can leave a webpack module reference outside its
  scope (`ReferenceError: e is not defined`) and silently fall back to main-thread
  processing. The unchanged worker and its Apache-2.0 license, including upstream
  copyright notices, are copied into the build.

Discord and Jellyfin keep their authenticated state in the same document.
Concurrent startup and session recovery share their in-flight work. Recovery
uses the already-held Discord OAuth token; the backend checks its application,
scope, expiry, user identity and current Activity membership before issuing a
replacement session. No cached identity or browser storage can supply that proof.
The Discord SDK stays connected during Jellyfin sign-out and sign-in.
Closing the Activity leaves the voice call connected.

Joining checks both the server URL and identity. A saved preferred connection
cannot replace an existing party. The login page uses that party's server and
maps the operator's canonical default to its configured public address for
presentation. To use another server, start another Activity. Account switching
keeps the Discord SDK document alive. The adapter unbinds SyncPlay before stopping
only local playback, closes its socket, and clears native query and cached view
state. That prevents a local account change from issuing a shared Stop or
showing the previous account's cached library.

Launch commands and the configured entry point respond only to a user invocation
and do not send an automatic channel invitation. Discord's native invitation and
Join Activity controls bring friends into the same running Activity. The native
Watch party button shows only its live participants and a Close control.

Discord Rich Presence follows actual local playback, using the native player
metadata without extra Jellyfin requests. Episodes show the series, season,
episode number or range, and episode title; movies show their title and year.
Playing media supplies a progress interval, adjusted for seeking and playback
speed and native transcoding offsets. Paused/buffering media shows its position without a moving clock. Stop,
account replacement and session recovery clear the previous title. Local media
events must establish playback before a preparatory manager event can publish it.
The manager event may also follow the DOM `playing` event or a failed play
attempt. A 15-second local read refreshes metadata without a network request.

Normal Activity authorization requests `identify` and `rpc.activities.write`.
Presence uses the granted scopes in Discord's authenticated response; denied or
unsupported presence never blocks the player or triggers another authorization
flow. The publisher coalesces changes with at least five seconds between RPCs,
keeps a stable playback clock, and shares its transport across account changes.
Only human-readable media metadata and public Discord application artwork are
published. Jellyfin tokens, server addresses, protected artwork, item identifiers
and custom join secrets never enter the presence payload. Discord owns invitations
and card rendering; its fixed application name remains **Jellyfin Watch**, and
compact cards may omit the richer fields. See [Discord's Activity Rich Presence
guide](https://docs.discord.com/developers/rich-presence/using-with-the-embedded-app-sdk).

For browser diagnostics, never print native network logs or raw gateway paths:
the `/jf/` path segment is a credential. A local HTTP smoke harness should load
an actual response from the candidate origin. Intercepting the top-level
document with Playwright `route.fulfill` can
give Chromium the wrong address-space classification and trigger a misleading
private-network CORS error. Verify the complete compiled document after changing
upstream integration patches. Mobile viewport checks do not verify physical iOS or Android media
policies, background playback, or outer Discord fullscreen.

For startup measurements, serve fixture responses over local HTTP and intercept
only WebSockets. Playwright HTTP routing disables the browser cache, so a routed
fixture cannot establish warm-cache behavior. Keep real compiled SDK code with
explicitly modeled parent RPC delays; report those delays and distinguish
synthetic Home/player timings from actual Discord or Jellyfin transcoding.

Seek previews keep Jellyfin's native slider, thumbnail crop, chapter label and
timestamp. The adapter preloads the current trickplay sheet when playback
metadata arrives and keeps at most two decoded image nodes for the current
item, media source and gateway capability. The loaded node becomes the native
preview, avoiding a second request for an uncached sheet. Until decoding succeeds,
the normal timestamp stays visible. Failed or timed-out images can retry on a
later hover after two seconds; there is no background retry loop. A changed
player, account or capability clears images and rejects late completions.
The final thumbnail index is clamped to `ThumbnailCount - 1`, including a seek
rounded to the video's duration. Chapter-only previews still use the upstream
renderer. The gateway path supplies authentication; image URLs retain
`MediaSourceId` and omit the redundant `ApiKey` query parameter.

A metadata request with `Fields=Chapters,Trickplay` is not a sprite request:
look specifically for `/Videos/{id}/Trickplay/{width}/{sheet}.jpg` when debugging.
HTTP 200 and a JPEG signature alone do not establish browser rendering; verify
decoded dimensions, native crop coordinates and visible pixels. These changes
address loading/error behavior and the reproducible final-frame boundary. They
do not establish the cause of a missing thumbnail that cannot be reproduced in
the real Discord renderer.

Jellyfin Web is GPL-2.0-or-later. The compiled output includes its license and
source metadata; this repository includes all modifications and the repeatable
source build. The upstream source is available at the pinned repository commit.

Install workspace dependencies before running
`node --test native-client/test/*.test.mjs`; the native DOM tests use the
workspace's `jsdom` dependency. Tests cover native dialogs and account matching,
controller recovery and party switching, source patches, document lifecycle,
playback permission and packaged assets. Run the real native production build to
verify patches against the pinned upstream source. `--prepare-only` applies them
without installing dependencies, but re-extracts the shared source tree: never
run it concurrently with a native build.

Build the session library with `pnpm --filter @app/activity-web build` and copy
`apps/activity-web/dist/` into `native-client/dist/` before local API serving. The
Docker build packages both automatically. The complete output includes the
early memory-storage script, the session library, native assets, HLS worker and
licenses.
