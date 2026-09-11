# Playback responsiveness implementation and verification

Status: **Implemented.** Updated September 11, 2026. The user first requested
a proposal before changing synchronization, then authorized implementation and
deployment. Automated checks cover the protocol, native integration and isolated
compiled clients; physical Discord desktop, Android and iOS observations must
be recorded separately. Release identity and passive deployment results belong
in the operational deployment record.

## Intended experience

Jellyfin's existing controls should act on the local player immediately, then
share the resulting intent with the party. Play/pause and buffered seeks should
not wait for another viewer. Next/Previous should immediately prepare the
chosen episode. Media loading, transcoding and device autoplay restrictions
still impose their own delays.

Other viewers follow asynchronously. A buffering viewer or new arrival should
catch up without pausing everyone. Volume, audio tracks, subtitles and quality
remain personal. Feedback belongs in native player controls, toasts and the
participant view; there is no additional playback toolbar.

## Findings in the previous native SyncPlay implementation

The pinned Jellyfin Web source is version 12.0.0, commit
`0e83c6a724b31f3e9b5a499244331a288c060a4a`, recorded in
[upstream.json](../native-client/upstream.json).

| Previous behavior | Source in pinned Jellyfin Web |
| --- | --- |
| Resume and seek send requests without immediately changing the local player; pause alone also pauses locally. | `src/plugins/syncPlay/core/Controller.js`, `unpause`, `seek`, `pause` |
| Play/pause toggles use the last received group command, which can lag a recent click. | `Controller.playPause`, `Manager.isPlaying` |
| Starting an item pauses the player before reporting Ready. | `QueueCore.scheduleReadyRequestOnPlaybackStart` |
| Seeking unpauses and seeks, then pauses again after Ready. | `PlaybackCore.scheduleSeek` |
| Viewer playback enables group waiting; buffering is reported after three seconds. | `Manager.followGroupPlayback`, `ui/players/HtmlVideoPlayer.js` |
| Every nonempty queue update fetches and translates its item list before updating the local queue. | `QueueCore.onPlayQueueUpdate` |

These methods are in the [pinned upstream SyncPlay directory](https://github.com/jellyfin/jellyfin-web/tree/0e83c6a724b31f3e9b5a499244331a288c060a4a/src/plugins/syncPlay).
The previous gateway forwarded playback requests without an Activity command
identifier, ordered acknowledgement or deduplication; see
[nativeGateway.ts](../apps/api/src/services/nativeGateway.ts) and
[nativeParty.ts](../apps/api/src/services/nativeParty.ts).

Jellyfin server 12.0 schedules resume using the greater of twice the highest
participant ping and its 500 ms default. This introduces a deliberate delay
after the request arrives. See [PlayingGroupState](https://github.com/jellyfin/jellyfin/blob/v12.0/MediaBrowser.Controller/SyncPlay/GroupStates/PlayingGroupState.cs#L55)
and [Group defaults](https://github.com/jellyfin/jellyfin/blob/v12.0/Emby.Server.Implementations/SyncPlay/Group.cs#L79).

The server also enters Waiting for joins, seeks and new queues. Another Unpause
while already waiting to resume explicitly forces playback and temporarily
ignores buffering. That provides a concrete explanation for why another click
can appear to work, but does not establish the cause of every reported missed
action. See [WaitingGroupState](https://github.com/jellyfin/jellyfin/blob/v12.0/MediaBrowser.Controller/SyncPlay/GroupStates/WaitingGroupState.cs#L181).

Calling local `play()` earlier or setting `IgnoreWait` alone would leave
scheduled commands and native pause-on-ready behavior able to undo the action.

## Implemented design

The native Jellyfin interface, player, library, account permissions and playback
reporting remain. An Activity-owned coordinator replaces upstream SyncPlay's
playback timing. Native clients outside the Activity do not join this coordinator.

1. **Apply local intent first.** Adapt the existing native controls to update
   play/pause/seek during the gesture. Toggle from the latest local intended
   state. Prepare a selected item through the normal authorized player path;
   never bypass permissions to make startup appear faster.
2. **Order changes once.** Use the existing authenticated Activity transport.
   Each command carries a session epoch, unique ID, client sequence, expected
   queue revision and explicit desired state. The backend validates it, assigns
   a monotonic party revision, updates the timeline atomically and broadcasts
   the result to every participant, including the sender.
3. **Acknowledge without replaying.** Deduplicate retries. A matching
   acknowledgement confirms the sender's local action without repeating it.
   Ignore stale revisions; reconcile a genuinely newer conflicting command.
   Next/Previous resolve to a specific item against a queue revision, so a
   retry cannot skip an extra episode. Commands are sent immediately over the
   existing socket; the sender does not wait for an earlier acknowledgement.
4. **Separate buffering from party intent.** Keep the party timeline moving
   when one device buffers. That device catches up when ready. Use bounded
   speed adjustment for small drift and a single seek for larger drift, with
   thresholds established by tests. Preserve paused seeks and mobile gesture
   recovery on the actual video element.
5. **Recover from current state.** Reconnect and popout/popin request the latest
   snapshot and epoch. Do not replay stale click history. Reject expired
   membership and invalidate commands on account replacement. Surface failed
   synchronization instead of silently leaving a viewer permanently detached.

Only the Activity engine controls playback. The gateway denies old SyncPlay
routes/events, the native document no longer joins a SyncPlay group, and native
SyncPlay command subscriptions are removed. Existing Discord playback commands
target the same coordinator. Login, account replacement and native socket
recovery use that coordinator in the same release.

The implementation is split across these reproducible sources:

- [activityPlayback.ts](../apps/api/src/services/activityPlayback.ts): serialized
  party state, access checks, command deduplication, revisions and broadcasts.
- [activityPlaybackClient.js](../native-client/src/activityPlaybackClient.js):
  optimistic local state, immediate sends, acknowledgements and recovery.
- [nativePlaybackAdapter.js](../native-client/src/nativePlaybackAdapter.js):
  native controls, prepared-item cache, queue entries and per-viewer drift correction.
- [activityPlaybackPatch.mjs](../native-client/activityPlaybackPatch.mjs):
  pinned-source hooks after native episode/parts/intros preparation, native
  automatic advancement and cancellation of stale asynchronous playback work.

Transport messages are `ActivityPlaybackCommand`, `ActivityPlaybackState` and
`ActivityPlaybackError` on the existing authenticated Jellyfin SDK socket.
`GET /jf/:capability/Activity/Playback` restores state. Commands contain the party
epoch, unique command ID, viewer sequence, expected queue revision and issue
time. The queue uses `{id, itemId}` entries, preserving duplicate media. Explicit
operations cover queue replacement/append, playback state, seek, selection,
Stop and shared repeat mode (`RepeatNone`, `RepeatOne`, `RepeatAll`). Changing
repeat mode or selecting an entry starts a fresh queue revision; retries retain
their original command ID. Automatic episode advancement follows the shared
queue even when a viewer disabled personal AutoNext. An ended HTML player has
already cleared its media source, so RepeatOne enters native preparation again
instead of seeking the cleared element. End callbacks carry their captured
queue revision, preventing a late callback from advancing newer playback.
When several viewers naturally finish together, the first accepted advancement
wins; the others quietly follow its queue revision. Manual conflicts and other
automatic-playback errors retain explicit feedback.

Drift checks run once per second while the local player is ready. Differences
of 250–1500 ms use a 3% rate adjustment; larger differences use a seek with a
three-second cooldown. The viewer's base playback rate is restored after catch-up.
These are initial implementation thresholds, subject to the validation below.
OS/autoplay interruptions cannot become party controls merely by emitting a
native pause event; native fullscreen controls require a recent trusted gesture.

## Acceptance criteria and delivery

- With 400–800 ms injected network delay, local play/pause and buffered seek
  initiate within 100 ms without a second click. Measure player effects
  separately from button animation and new-media readiness.
- Rapid play/pause sequences and repeated seeks converge on the latest intent.
  Duplicate or reordered messages do not undo it or double-advance episodes.
- A slow, backgrounded or reconnecting viewer does not pause the others.
  Late joiners recover the current item, position and paused/playing state.
- Reconnection, account replacement and popout/popin reject stale callbacks,
  preserve the correct party and do not replay previous commands.
- Permission denials, unavailable media and expired membership produce clear
  native feedback and preserve the gateway's access boundaries.
- Verify two isolated compiled clients first, then real Discord desktop,
  Android and iOS. A mobile viewport does not establish device autoplay or
  background behavior. Record local latency and remote convergence separately.

Source-level tests exercise immediate player effects before transport sends,
rapid Next selection, native queue edits and duplicate media entries, paused
seeks, buffering/OS event isolation, stale native preparation after Stop or
account replacement, and native pipeline ownership after delayed media queries.
Source tests also execute native end handling with personal AutoNext disabled,
check shared repeat choices, same-entry restart and queue insertion during
pending hydration, and verify participant access
for accounts without upstream SyncPlay permission. Mobile orientation methods
keep their owning browser receiver, avoiding the reproducible illegal-invocation
error in Chromium touch emulation.
Protocol tests cover ordering, retries, revision conflicts and reconnection.
These checks do not establish physical Discord/mobile playback behavior.

Complete the pinned production build and two-client compiled-browser tests with
controlled transport delay, then follow the normal [deployment workflow](deployment.md).
Record actual device observations separately from synthetic browser results.
Do not edit generated `.build/source`, run `--prepare-only` or execute native
tests concurrently with the source build: the build replaces its source and
installed dependencies. Run native tests after the build completes. Record the
verified source revision and image in the operational deployment record.
