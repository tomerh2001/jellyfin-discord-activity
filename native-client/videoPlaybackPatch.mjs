const original = `    unpause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }`;
const patched = `    unpause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return playWithGestureRecovery(mediaElement);
        }
    }`;

export function patchVideoUnpause(source) {
    const importAnchor = "import Screenfull from 'screenfull';";
    if (source.split(original).length !== 2 || source.split(importAnchor).length !== 2) {
        throw new Error('Upstream video unpause patch anchor changed');
    }
    return source.replace(importAnchor, `${importAnchor}\nimport { playWithGestureRecovery } from '../../discordActivity/mediaPlayback';`)
        .replace(original, patched);
}
