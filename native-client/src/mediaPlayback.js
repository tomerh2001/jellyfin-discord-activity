import { PLAYBACK_BLOCKED_EVENT } from './playbackPermission.js';

/** Native unpause/resume must expose the same gesture recovery as initial play. */
export function playWithGestureRecovery(media) {
    const failed = error => {
        const name = String(error?.name || '').toLowerCase();
        if (name !== 'notallowederror' && name !== 'aborterror') throw error;
        const MediaEvent = media.ownerDocument.defaultView.Event;
        media.dispatchEvent(new MediaEvent(PLAYBACK_BLOCKED_EVENT, { bubbles: true }));
    };
    try {
        // Keep the original synchronous play call and all native SyncPlay timing.
        return Promise.resolve(media.play()).catch(failed);
    } catch (error) {
        return Promise.resolve().then(() => failed(error));
    }
}
