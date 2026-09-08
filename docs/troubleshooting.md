# Troubleshooting

- **Open Jellyfin Watch in Discord:** close the Activity and launch `/watch` again. Discord permits authentication once per Embedded SDK connection; do not reload the authenticated iframe.
- **Server address refused:** enter the server base URL without `/web`, credentials or a query. Generic instances need publicly resolvable HTTPS. Only the exact operator default permits private networking or HTTP; redirects are intentionally rejected.
- **Join the party's server:** connect an account to the Jellyfin server already selected for this Activity. A saved preferred server does not replace an active party. All viewers need access to the selected items.
- **No audio on a phone:** tap the native player once. Check the player's volume and Discord's call controls. Browser autoplay, codecs and fullscreen depend on the actual Discord/device combination.
- **Buffering or black video:** test the same item in normal Jellyfin Web, inspect the native player's playback information, and check Jellyfin's transcoding logs. Each participant negotiates a separate stream; subtitles may require transcoding.
- **Disconnected party:** reopen your saved account from **Accounts**. Lost sockets leave SyncPlay so they cannot hold other viewers in a waiting state. Closing the last viewer eventually removes the group.
- **Invite fails:** confirm channel invite permission and use Discord's existing Join Activity button. Invitation availability depends on the channel and Discord context.
- **A command does not affect playback:** join the voice channel and wait for the Activity's native player to connect. Commands use the caller's own native session and the current party binding.
- **403 before the UI loads:** inspect the configured ingress proof and exact hostname mapping. Do not disable the gate or replace it with Origin/Referer checks. See [security](security.md).

Use redacted backend logs. Raw native Jellyfin console/network output can contain the temporary gateway capability; do not paste it into issues. Test desktop, iOS and Android separately before reporting cross-platform playback verified.
