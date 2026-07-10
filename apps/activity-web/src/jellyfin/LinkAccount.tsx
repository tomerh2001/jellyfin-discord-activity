import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import {
  getJellyfinLibraries,
  getJellyfinStatus,
  linkJellyfinAccount,
  unlinkJellyfinAccount
} from "../api/client.js";
import type { JellyfinLibrary, JellyfinStatus } from "../api/types.js";
import { Button } from "../components/Button.js";

type LinkAccountProps = {
  appToken: string | undefined;
  authMode: "per-user" | "shared";
  linkedFromMe: boolean;
  onLinkedChange: (linked: boolean) => void;
};

type RequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

export function LinkAccount({ appToken, authMode, linkedFromMe, onLinkedChange }: LinkAccountProps) {
  const [status, setStatus] = useState<JellyfinStatus>({ linked: linkedFromMe, authMode });
  const [libraries, setLibraries] = useState<JellyfinLibrary[]>([]);
  const [requestState, setRequestState] = useState<RequestState>({ status: "idle" });

  useEffect(() => {
    if (!appToken) {
      setStatus({ linked: false, authMode });
      setLibraries([]);
      return;
    }

    const token = appToken;
    const controller = new AbortController();

    async function loadStatus() {
      try {
        const nextStatus = await getJellyfinStatus(token, controller.signal);
        setStatus(nextStatus);
        onLinkedChange(nextStatus.linked);

        if (nextStatus.linked) {
          const nextLibraries = await getJellyfinLibraries(token, controller.signal);
          setLibraries(nextLibraries.libraries);
        } else {
          setLibraries([]);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRequestState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load Jellyfin status."
          });
        }
      }
    }

    void loadStatus();

    return () => controller.abort();
  }, [appToken, authMode, linkedFromMe, onLinkedChange]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!appToken) {
      setRequestState({ status: "error", message: "Authenticate with Discord before linking Jellyfin." });
      return;
    }

    const formData = new FormData(event.currentTarget);
    const serverUrl = stringValue(formData.get("serverUrl"));
    const username = stringValue(formData.get("username"));
    const password = stringValue(formData.get("password"));

    setRequestState({ status: "loading" });

    try {
      const linked = await linkJellyfinAccount(appToken, {
        ...(serverUrl ? { serverUrl } : {}),
        username,
        password
      });
      const nextStatus = {
        linked: true,
        authMode: "per-user" as const,
        serverUrl: linked.serverUrl,
        username: linked.jellyfinUser.name
      };
      const nextLibraries = await getJellyfinLibraries(appToken);

      setStatus(nextStatus);
      setLibraries(nextLibraries.libraries);
      onLinkedChange(true);
      setRequestState({ status: "idle" });
      event.currentTarget.reset();
    } catch (error) {
      setRequestState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not link Jellyfin account."
      });
    }
  }

  async function unlink() {
    if (!appToken) {
      return;
    }

    setRequestState({ status: "loading" });

    try {
      await unlinkJellyfinAccount(appToken);
      setStatus({ linked: false, authMode: "per-user" });
      setLibraries([]);
      onLinkedChange(false);
      setRequestState({ status: "idle" });
    } catch (error) {
      setRequestState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not unlink Jellyfin account."
      });
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{authMode === "shared" ? "Jellyfin shared account" : "Jellyfin account"}</h2>
        <span className="status-pill">{status.linked ? "linked" : "not linked"}</span>
      </div>

      {appToken ? null : (
        <p>Authenticate with Discord before linking Jellyfin.</p>
      )}

      {authMode === "shared" ? (
        <div className="linked-account">
          {status.linked ? (
            <p>
              Shared playback uses <strong>{status.username}</strong>
              {status.serverUrl ? ` on ${status.serverUrl}` : ""}.
            </p>
          ) : (
            <p>The shared Jellyfin account is not ready.</p>
          )}
        </div>
      ) : status.linked ? (
        <div className="linked-account">
          <p>
            Signed in as <strong>{status.username}</strong>
            {status.serverUrl ? ` on ${status.serverUrl}` : ""}
          </p>
          <Button disabled={requestState.status === "loading"} onClick={() => void unlink()}>
            Unlink Jellyfin
          </Button>
        </div>
      ) : (
        <form className="link-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>Server URL</span>
            <input name="serverUrl" placeholder="Blank uses configured default" type="url" />
          </label>
          <label>
            <span>Username</span>
            <input autoComplete="username" name="username" required />
          </label>
          <label>
            <span>Password</span>
            <input autoComplete="current-password" name="password" required type="password" />
          </label>
          <Button disabled={!appToken || requestState.status === "loading"} type="submit">
            {requestState.status === "loading" ? "Linking" : "Link Jellyfin"}
          </Button>
        </form>
      )}

      {requestState.status === "error" ? (
        <p className="inline-error">{requestState.message}</p>
      ) : null}

      {libraries.length > 0 ? (
        <div className="library-list">
          <span className="eyebrow">Libraries</span>
          <ul>
            {libraries.map((library) => (
              <li key={library.id}>{library.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
