import { useEffect, useState } from "react";
import { getJellyfinItemImage } from "../api/client.js";
import type { JellyfinItem } from "../api/types.js";
import { Button } from "../components/Button.js";

type PlayableListItemProps = {
  item: JellyfinItem;
  appToken: string | undefined;
  disabled?: boolean;
  selected?: boolean;
  onSelect: (item: JellyfinItem) => void;
};

export function PlayableListItem({ item, appToken, disabled = false, selected = false, onSelect }: PlayableListItemProps) {
  const [artworkUrl, setArtworkUrl] = useState<string | undefined>();
  const imageItemId = item.imageItemId ?? item.id;
  const canLoadArtwork = Boolean(appToken && item.imageTag && imageItemId);

  useEffect(() => {
    if (!appToken || !canLoadArtwork) {
      setArtworkUrl(undefined);
      return;
    }

    const token = appToken;
    const resolvedImageItemId = imageItemId;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setArtworkUrl(undefined);

    async function loadArtwork() {
      try {
        const blob = await getJellyfinItemImage(token, resolvedImageItemId, {
          width: 220,
          height: 124,
          ...(item.imageTag ? { tag: item.imageTag } : {})
        }, controller.signal);

        objectUrl = URL.createObjectURL(blob);
        setArtworkUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted) {
          setArtworkUrl(undefined);
        }
      }
    }

    void loadArtwork();

    return () => {
      controller.abort();

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [appToken, canLoadArtwork, imageItemId, item.imageTag]);

  return (
    <article className={selected ? "playable-row selected-media-card" : "playable-row"}>
      <div className="playable-thumbnail">
        {artworkUrl ? (
          <img alt={`${item.name} artwork`} className="poster-art" src={artworkUrl} />
        ) : (
          <div className="poster-placeholder">
            <span>{item.type}</span>
          </div>
        )}
      </div>

      <div className="playable-main">
        <h3>{item.name}</h3>
        <p className="playable-overview">{item.overview?.trim() || "No description available."}</p>
        <p className="runtime-line">{formatRuntime(item.runtimeTicks)}</p>
      </div>

      <div className="playable-side">
        <div className="playable-numbering" aria-label={metadataAriaLabel(item)}>
          <span>{metadataTopLine(item)}</span>
          <strong>{metadataBottomLine(item)}</strong>
        </div>
        <Button disabled={disabled} onClick={() => onSelect(item)}>
          {selected ? "Selected" : "Select"}
        </Button>
      </div>
    </article>
  );
}

function metadataTopLine(item: JellyfinItem): string {
  if (item.type === "Episode") {
    return seasonLabel(item);
  }

  return item.productionYear ? String(item.productionYear) : "Movie";
}

function metadataBottomLine(item: JellyfinItem): string {
  if (item.type === "Episode") {
    return episodeLabel(item);
  }

  return "Movie";
}

function metadataAriaLabel(item: JellyfinItem): string {
  return `${metadataTopLine(item)}, ${metadataBottomLine(item)}`;
}

function seasonLabel(item: JellyfinItem): string {
  if (item.seasonName?.trim()) {
    return item.seasonName;
  }

  if (typeof item.parentIndexNumber === "number") {
    return item.parentIndexNumber === 0 ? "Specials" : `Season ${item.parentIndexNumber}`;
  }

  return "Season";
}

function episodeLabel(item: JellyfinItem): string {
  return typeof item.indexNumber === "number" ? `Episode ${item.indexNumber}` : "Episode";
}

function formatRuntime(runtimeTicks: number | null | undefined): string {
  if (!runtimeTicks) {
    return "Runtime: Unknown";
  }

  const totalSeconds = Math.max(0, Math.floor(runtimeTicks / 10_000_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `Runtime: ${padTime(hours)}:${padTime(minutes)}:${padTime(seconds)}`;
}

function padTime(value: number): string {
  return value.toString().padStart(2, "0");
}
