// Changing the native client invalidates both React state and cached view controllers.
let snapshot = Object.freeze({ revision: 0, pending: false });
const listeners = new Set();

function publish(pending, revision) {
    snapshot = Object.freeze({ revision, pending });
    for (const listener of listeners) listener();
}

export const getAccountView = () => snapshot;
export const subscribeAccountView = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
export const beginAccountViewChange = () => publish(true, snapshot.revision + 1);
export const finishAccountViewChange = () => publish(false, snapshot.revision);
