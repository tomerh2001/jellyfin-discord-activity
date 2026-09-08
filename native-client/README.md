# Native Jellyfin client

`node native-client/build.mjs` builds the actual Jellyfin Web 10.11.11 client.
Use Node22 with its npm10 and `tar`; no global npm installation is required.
The source commit, archive SHA256 and license are pinned in `upstream.json`.
The upstream npm lockfile supplies dependency integrity. Output goes to `dist/`
and the Activity API serves its `index.html` at the mapped origin's root.
The native HashRouter owns navigation within the Activity document.

The build applies a small integration patch before compiling the upstream source:

- The native document loads the [session library](../apps/activity-web/README.md)
  once, before the adapter initializes. That library supplies Discord SDK
  authentication and the broker API without rendering a separate interface.
  Native initialization loads the translation dictionary, authenticates Discord,
  selects the Jellyfin connection, and then renders the native application.
- The existing header SyncPlay button, also available in the native video OSD,
  opens **Watch party**. Its native action sheet offers invitations, accounts,
  shared server changes, SyncPlay settings, local playback resume/halt when
  available, and leaving. Fullscreen stays with Jellyfin's player controls.
- Account selection uses upstream `dialogHelper`, native form classes and
  `emby-button`/`emby-input` controls. It supports saved accounts, server URL and
  password login, Quick Connect, explicit community-account selection, and saved
  account removal. Native login and server-selection routes open this chooser.
  Quick Connect polls sequentially and aborts on cancellation; late results
  cannot select an account after the dialog closes. Failed requests leave an
  actionable native error state with loading cleared.
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
  part of the Activity UI.
- A blocked media element opens a native **Join playback** dialog containing
  **Tap to play on this device**. The click calls that exact element's `play()` before any asynchronous
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
  not require another OAuth exchange or a new document. Jellyfin's standard
  fullscreen control acts on a user click; Discord's embedding
  policy can refuse it, and the Activity cannot force the outer Discord
  application window into fullscreen. See [Discord layouts](https://docs.discord.com/developers/activities/development-guides/layout)
  and [fullscreen requirements](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).
- [HLS.js](https://github.com/video-dev/hls.js) 1.6.13 uses its lockfile-pinned
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
Explicit leaving revokes the app session, clears retained authorization and
closes the Activity while keeping the voice call connected.

Joining checks both the server URL and identity. A saved preferred connection
cannot replace an existing party. **Change server** requires a separate native
confirmation; other viewers detect the replacement and choose an account for
the new server. Account switching keeps the Discord SDK document alive. Before
installing the next native ApiClient, the adapter unbinds SyncPlay, stops only
local playback, closes its socket, and clears native query and cached view state.
That prevents a local account change from issuing a shared Stop or displaying
the previous account's cached library.

Launch commands and the configured application-handled entry point respond only
to a user invocation and do not send an automatic channel invitation. **Watch
party → Invite friends** explicitly opens Discord's invitation dialog. A launch
in another text channel belongs to that channel; friends must join the same
running Activity to share its SyncPlay group.

For browser diagnostics, never print native network logs or raw gateway paths:
the `/jf/` path segment is a credential. A local HTTP smoke harness should load
an actual response from the candidate origin. Intercepting the top-level
document with Playwright `route.fulfill` can
give Chromium the wrong address-space classification and trigger a misleading
private-network CORS error. Verify the complete compiled document after changing
upstream integration patches. Mobile viewport checks do not verify physical iOS or Android media
policies, background playback, or outer Discord fullscreen.

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
