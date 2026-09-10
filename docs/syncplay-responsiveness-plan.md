# Playback responsiveness proposal

Status: **Proposed, not implemented.** Reviewed September 11, 2026. The user
requested a plan before changes to synchronization behavior. Account login and
participant visibility are separate authorized fixes; they continue using the
existing native SyncPlay group.

## Intended experience

Jellyfin's existing controls should act on the local player immediately, then
share the resulting intent with the party. Play/pause and buffered seeks should
not wait for another viewer. Next/Previous should immediately prepare the
chosen episode. Media loading, transcoding and device autoplay restrictions
still impose their own delays.

Other viewers follow asynchronously. A buffering viewer or new arrival should
catch up without pausing everyone. Volume, audio tracks, subtitles and quality
remain personal. Feedback belongs in native player controls, toasts and the
participant view; no additional playback toolbar is proposed.

## Findings

The pinned Jellyfin Web source is version 12.0.0, commit
`0e83c6a724b31f3e9b5a499244331a288c060a4a`, recorded in
[upstream.json](../native-client/upstream.json).

| Current behavior | Source in pinned Jellyfin Web |
| --- | --- |
| Resume and seek send requests without immediately changing the local player; pause alone also pauses locally. | `src/plugins/syncPlay/core/Controller.js`, `unpause`, `seek`, `pause` |
| Play/pause toggles use the last received group command, which can lag a recent click. | `Controller.playPause`, `Manager.isPlaying` |
| Starting an item pauses the player before reporting Ready. | `QueueCore.scheduleReadyRequestOnPlaybackStart` |
| Seeking unpauses and seeks, then pauses again after Ready. | `PlaybackCore.scheduleSeek` |
| Viewer playback enables group waiting; buffering is reported after three seconds. | `Manager.followGroupPlayback`, `ui/players/HtmlVideoPlayer.js` |
| Every nonempty queue update fetches and translates its item list before updating the local queue. | `QueueCore.onPlayQueueUpdate` |

These methods are in the [pinned upstream SyncPlay directory](https://github.com/jellyfin/jellyfin-web/tree/0e83c6a724b31f3e9b5a499244331a288c060a4a/src/plugins/syncPlay).
The gateway currently forwards playback requests without an Activity command
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

## Recommended implementation

Keep the native Jellyfin interface, player, library, account permissions and
playback reporting. Replace upstream SyncPlay's playback timing inside the
Activity with one Activity-owned coordinator. This is an explicit change of
synchronization engine, not a claim that a native setting provides the proposed
behavior. Native clients outside the Activity would not join this coordinator.

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
   retry cannot skip an extra episode. Coalesce superseded unsent seek intents.
4. **Separate buffering from party intent.** Keep the party timeline moving
   when one device buffers. That device catches up when ready. Use bounded
   speed adjustment for small drift and a single seek for larger drift, with
   thresholds established by tests. Preserve paused seeks and mobile gesture
   recovery on the actual video element.
5. **Recover from current state.** Reconnect and popout/popin request the latest
   snapshot and epoch. Do not replay stale click history. Reject expired
   membership and invalidate commands on account replacement. Surface failed
   synchronization instead of silently leaving a viewer permanently detached.

Only one engine may control playback. The approved implementation must replace
the old SyncPlay controller bindings, waiting callbacks and playback-command
subscriptions together; running both engines would reintroduce conflicting
pauses and seeks. Queue ownership and automatic episode advancement must move
with the timeline. Existing Discord playback commands must target the same
coordinator so they cannot create a second playback authority. Native login/party
lifecycle will need to target that new
coordinator in the same release.

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

After approval, implement the protocol/state-machine tests and native adapter,
then run the complete source build and focused failure-injection scenarios.
Use reproducible build patches rather than editing generated `.build/source`.
Release through a reviewed PR, CI-published image and the normal
[deployment workflow](deployment.md). This document does not authorize or
report that implementation or deployment.
