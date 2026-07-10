import { useEffect, useState } from "react";
import type { JellyfinItem } from "../api/types.js";
import { getJellyfinItemImage } from "../api/client.js";
import { Button } from "../components/Button.js";

type MediaCardProps = {
  item: JellyfinItem;
  appToken: string | undefined;
  disabled?: boolean;
  actionLabel?: string;
  selected?: boolean;
  viewMode: "grid" | "list";
  onSelect: (item: JellyfinItem) => void;
};

export function MediaCard({ item, appToken, actionLabel, disabled = false, selected = false, viewMode, onSelect }: MediaCardProps) {
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
        const imageRequest = {
          width: viewMode === "list" ? 120 : 320,
          height: viewMode === "list" ? 180 : 480,
          ...(item.imageTag ? { tag: item.imageTag } : {})
        };
        const blob = await getJellyfinItemImage(token, resolvedImageItemId, imageRequest, controller.signal);

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
  }, [appToken, canLoadArtwork, imageItemId, item.imageTag, viewMode]);

  const className = [
    "media-card",
    viewMode === "list" ? "media-card-list" : "",
    selected ? "selected-media-card" : ""
  ].filter(Boolean).join(" ");
  const subtitle = mediaSubtitle(item);

  return (
    <article className={className}>
      <div className="poster-frame">
        {artworkUrl ? (
          <img alt={`${item.name} artwork`} className="poster-art" src={artworkUrl} />
        ) : (
          <div className="poster-placeholder">
            <span>{item.type}</span>
          </div>
        )}
      </div>
      <div className="media-card-body">
        <span className="media-type-pill">{item.type}</span>
        <h3>{item.name}</h3>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <Button disabled={disabled} onClick={() => onSelect(item)}>
        {selected ? "Selected" : actionLabel ?? "Select"}
      </Button>
    </article>
  );
}

function mediaSubtitle(item: JellyfinItem): string {
  const parts = [
    item.seriesName,
    item.seasonName,
    item.productionYear?.toString()
  ].filter(Boolean);

  return parts.join(" · ");
}
