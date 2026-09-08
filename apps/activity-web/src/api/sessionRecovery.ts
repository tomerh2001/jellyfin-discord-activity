type Listener = (appToken: string) => void;
const listeners = new Set<Listener>();

export function onSessionRejected(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifySessionRejected(appToken: string): void {
  for (const listener of listeners) listener(appToken);
}
