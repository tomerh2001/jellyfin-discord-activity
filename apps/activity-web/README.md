# Native document session library

This package builds `dist/activity-session.js`, a browser IIFE exposing
`window.JellyfinWatch`. Load it once as a classic script before the native Jellyfin
adapter initializes. Evaluating it does not create a view, iframe, SDK connection
or API request. Jellyfin owns the document and its controls.

The facade keeps the existing authenticated broker API:

| Function | Arguments and result |
| --- | --- |
| `startActivitySession` | No arguments; returns `{discord, exchange}` after Discord sign-in. Concurrent calls share startup and the SDK instance. |
| `resumeActivitySession` | No arguments; returns a verified replacement session using retained OAuth proof. Does not authorize the authenticated SDK again. |
| `clearActivitySession` | Disposes retained session state; a late recovery token is revoked. |
| `logout` | `(appToken)`; revokes the broker session. Clear local state and close the Activity after success. |
| `getConnections` | `(appToken, signal?)`; returns saved connections, preference and community availability. |
| `getParty` | `(appToken, signal?)`; returns the current party or `null`. |
| `joinParty` | `(appToken, connectionId)`; explicitly binds the party. |
| `launchNative` | `(appToken, connectionId, deviceId)`; returns the opaque gateway launch. |
| `matchesPartyServer` | `(connection, party)`; checks both server ID and URL. |
| `savePreference` | `(appToken, connectionId)`. |
| `connectAccount` | `(appToken, {serverUrl, username, password})`; returns the saved connection. |
| `connectCommunity` | `(appToken)`; returns the community connection when permitted. |
| `deleteConnection` | `(appToken, connectionId)`. |
| `startQuickConnect` | `(appToken, serverUrl)`; returns `{id, code, expiresAt}`. |
| `pollQuickConnect` | `(appToken, id, signal?)`; returns pending or connected status. |
| `onSessionRejected` | `(callback)`; callback receives the rejected app token only for `invalid_app_token` responses. Returns teardown. |
| `closeDiscordActivity` | `(discord)`; closes the Activity SDK connection. |
| `getConnectedParticipants` | `(discord)`; returns current Activity participants. |
| `observeActivityPresentation` | `(discord, callback)`; immediately reports `{layout, preview}`, follows layout/viewport changes, and returns teardown. |

Presentation values are `focused`, `pip`, and `grid`. Viewport fallback recognizes
a small preview; a normal portrait phone retains the focused layout. Observation
does not change authentication, playback, orientation, or window fullscreen.

Tokens stay in document memory. Credentials are submitted to authenticated broker
endpoints, and native launches must use an opaque same-origin `/jf/…` path. The
native adapter must unsubscribe and dispose its session when leaving, suppress
recovery once logout starts, and limit automatic recovery to prevent retry loops.

Use `pnpm --filter @app/activity-web build` to produce the library and branding
assets. `dev` watches the library build for the API server to serve; it does not
run a separate UI. Run this package's `test`, `typecheck`, and `lint` commands for
its session, API and layout checks. `jsdom` remains a development dependency for
both these tests and the native document lifecycle regression test.
