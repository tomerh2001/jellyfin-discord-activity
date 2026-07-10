import { ChevronRight, Grid2X2, List } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getJellyfinItem,
  getJellyfinItems,
  getJellyfinLibraries
} from "../api/client.js";
import type { JellyfinItem, JellyfinLibrary } from "../api/types.js";
import { Button } from "../components/Button.js";
import { MediaCard } from "./MediaCard.js";
import { PlayableListItem } from "./PlayableListItem.js";
import { SearchBox } from "./SearchBox.js";

type LibraryBrowserProps = {
  appToken: string | undefined;
  canSelectMedia: boolean;
  selectedItemId: string | undefined;
  onSelectMedia: (item: JellyfinItem) => void;
};

type BrowseNode = {
  id: string;
  name: string;
  type: string;
  indexNumber?: number | null;
  parentIndexNumber?: number | null;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string };

const playableTypes = new Set(["Movie", "Episode"]);
const containerTypes = new Set(["Series", "Season", "Folder", "BoxSet"]);
const pageSize = 100;

export function LibraryBrowser({ appToken, canSelectMedia, selectedItemId, onSelectMedia }: LibraryBrowserProps) {
  const [libraries, setLibraries] = useState<JellyfinLibrary[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | undefined>();
  const [browseStack, setBrowseStack] = useState<BrowseNode[]>([]);
  const [items, setItems] = useState<JellyfinItem[]>([]);
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState<JellyfinItem | undefined>();
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [totalRecordCount, setTotalRecordCount] = useState(0);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const disabled = !appToken || !canSelectMedia;
  const selectedLibrary = useMemo(
    () => libraries.find((library) => library.id === selectedLibraryId),
    [libraries, selectedLibraryId]
  );
  const currentNode = browseStack.at(-1);
  const isSearching = query.trim().length > 0;
  const isEpisodeLevel = !isSearching && currentNode?.type === "Season";
  const isMovieList = !isSearching && selectedLibrary?.collectionType === "movies";
  const usesPlayableRows = isEpisodeLevel || isMovieList;
  const displayItems = useMemo(
    () => isEpisodeLevel ? filterSeasonEpisodes(items, currentNode).sort(compareEpisodes) : items,
    [currentNode, isEpisodeLevel, items]
  );

  useEffect(() => {
    if (!appToken || !canSelectMedia) {
      setLibraries([]);
      setSelectedLibraryId(undefined);
      setBrowseStack([]);
      setItems([]);
      setTotalRecordCount(0);
      return;
    }

    const token = appToken;
    const controller = new AbortController();

    async function loadLibraries() {
      setLoadState({ status: "loading" });

      try {
        const response = await getJellyfinLibraries(token, controller.signal);
        setLibraries(response.libraries);
        setSelectedLibraryId((current) => current ?? response.libraries[0]?.id);
        setLoadState({ status: "idle" });
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load Jellyfin libraries."
          });
        }
      }
    }

    void loadLibraries();

    return () => controller.abort();
  }, [appToken, canSelectMedia]);

  useEffect(() => {
    setBrowseStack([]);
    setDetails(undefined);
    setQuery("");
  }, [selectedLibraryId]);

  useEffect(() => {
    if (!appToken || !canSelectMedia || !selectedLibrary) {
      setItems([]);
      return;
    }

    const token = appToken;
    const library = selectedLibrary;
    const node = currentNode;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      async function loadItems() {
        setLoadState({ status: "loading" });

        try {
          const parentIndexNumber = episodeParentIndexNumber(node);
          const response = await getJellyfinItems(token, {
            parentId: node?.id ?? library.id,
            query,
            type: isSearching ? "Series,BoxSet,Movie,Episode" : browseTypesFor(library, node),
            recursive: isSearching,
            ...(parentIndexNumber !== undefined ? { parentIndexNumber } : {}),
            startIndex: 0,
            limit: pageSize
          }, controller.signal);

          setItems(response.items);
          setTotalRecordCount(response.totalRecordCount);
          setLoadState({ status: "idle" });
        } catch (error) {
          if (!controller.signal.aborted) {
            setLoadState({
              status: "error",
              message: error instanceof Error ? error.message : "Could not load Jellyfin items."
            });
          }
        }
      }

      void loadItems();
    }, isSearching ? 250 : 0);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [appToken, canSelectMedia, currentNode, isSearching, query, selectedLibrary]);

  async function activateItem(item: JellyfinItem) {
    if (!appToken || disabled) {
      return;
    }

    if (isContainer(item)) {
      setBrowseStack((current) => [...current, {
        id: item.id,
        name: item.name,
        type: item.type,
        ...(item.indexNumber !== undefined ? { indexNumber: item.indexNumber } : {}),
        ...(item.parentIndexNumber !== undefined ? { parentIndexNumber: item.parentIndexNumber } : {})
      }]);
      setQuery("");
      setDetails(undefined);
      return;
    }

    if (!isPlayable(item)) {
      return;
    }

    try {
      const response = await getJellyfinItem(appToken, item.id);
      setDetails(response.item);
      onSelectMedia(response.item);
    } catch {
      setDetails(item);
      onSelectMedia(item);
    }
  }

  function selectLibrary(libraryId: string): void {
    setSelectedLibraryId(libraryId);
  }

  function goToCrumb(index: number): void {
    setBrowseStack((current) => current.slice(0, index));
    setDetails(undefined);
  }

  async function loadMoreItems() {
    if (!appToken || !selectedLibrary || loadState.status === "loading") {
      return;
    }

    setLoadState({ status: "loading" });

    try {
      const parentIndexNumber = episodeParentIndexNumber(currentNode);
      const response = await getJellyfinItems(appToken, {
        parentId: currentNode?.id ?? selectedLibrary.id,
        query,
        type: isSearching ? "Series,BoxSet,Movie,Episode" : browseTypesFor(selectedLibrary, currentNode),
        recursive: isSearching,
        ...(parentIndexNumber !== undefined ? { parentIndexNumber } : {}),
        startIndex: items.length,
        limit: pageSize
      });

      setItems((current) => [...current, ...response.items]);
      setTotalRecordCount(response.totalRecordCount);
      setLoadState({ status: "idle" });
    } catch (error) {
      setLoadState({
        status: "error",
        message: error instanceof Error ? error.message : "Could not load more Jellyfin items."
      });
    }
  }

  return (
    <section className="panel library-browser">
      <div className="panel-heading">
        <h2>Library</h2>
        <span className="status-pill">host</span>
      </div>

      <div className="library-tabs" role="tablist" aria-label="Jellyfin libraries">
        {libraries.map((library) => (
          <Button
            disabled={disabled}
            key={library.id}
            onClick={() => selectLibrary(library.id)}
          >
            {library.name}
          </Button>
        ))}
      </div>

      <SearchBox disabled={disabled || !selectedLibraryId} onChange={setQuery} value={query} />

      {selectedLibrary ? (
        <>
          <nav aria-label="Library path" className="breadcrumb-bar">
            <button disabled={disabled} onClick={() => goToCrumb(0)} type="button">
              {selectedLibrary.name}
            </button>
            {browseStack.map((node, index) => (
              <span className="breadcrumb-step" key={node.id}>
                <ChevronRight aria-hidden="true" size={16} />
                <button disabled={disabled} onClick={() => goToCrumb(index + 1)} type="button">
                  {node.name}
                </button>
              </span>
            ))}
          </nav>

          <div className="library-results-heading">
            <p className="muted-line">{isSearching ? `Search results for "${query.trim()}"` : browseLabel(selectedLibrary, currentNode)}</p>
            {!usesPlayableRows ? (
              <div className="view-toggle" role="group" aria-label="Library view">
                <button
                  aria-pressed={viewMode === "grid"}
                  className={viewMode === "grid" ? "icon-button active" : "icon-button"}
                  disabled={disabled}
                  onClick={() => setViewMode("grid")}
                  title="Thumbnail view"
                  type="button"
                >
                  <Grid2X2 aria-hidden="true" size={18} />
                  <span className="sr-only">Thumbnail view</span>
                </button>
                <button
                  aria-pressed={viewMode === "list"}
                  className={viewMode === "list" ? "icon-button active" : "icon-button"}
                  disabled={disabled}
                  onClick={() => setViewMode("list")}
                  title="List view"
                  type="button"
                >
                  <List aria-hidden="true" size={18} />
                  <span className="sr-only">List view</span>
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {loadState.status === "loading" ? (
        <p className="muted-line">Loading Jellyfin items.</p>
      ) : null}

      {loadState.status === "error" ? (
        <p className="inline-error">{loadState.message}</p>
      ) : null}

      <div className={usesPlayableRows ? "playable-list" : viewMode === "list" ? "media-list" : "media-grid"}>
        {displayItems.map((item) => (
          shouldRenderPlayableRow(item, { isEpisodeLevel, isMovieList }) ? (
            <PlayableListItem
              appToken={appToken}
              disabled={disabled || !isPlayable(item)}
              item={item}
              key={item.id}
              onSelect={(nextItem) => void activateItem(nextItem)}
              selected={selectedItemId === item.id}
            />
          ) : (
            <MediaCard
              actionLabel={isContainer(item) ? "Open" : "Select"}
              appToken={appToken}
              disabled={disabled || (!isPlayable(item) && !isContainer(item))}
              item={item}
              key={item.id}
              onSelect={(nextItem) => void activateItem(nextItem)}
              selected={selectedItemId === item.id}
              viewMode={viewMode}
            />
          )
        ))}
      </div>

      {displayItems.length === 0 && loadState.status === "idle" && selectedLibrary ? (
        <p className="muted-line">No Jellyfin items found here.</p>
      ) : null}

      {items.length > 0 && items.length < totalRecordCount ? (
        <div className="load-more-row">
          <Button disabled={disabled || loadState.status === "loading"} onClick={() => void loadMoreItems()}>
            {loadState.status === "loading" ? "Loading" : `Load more (${items.length} of ${totalRecordCount})`}
          </Button>
        </div>
      ) : null}

      {details ? (
        <section className="item-details">
          <span className="eyebrow">Selected</span>
          <h3>{details.name}</h3>
          {details.overview ? <p>{details.overview}</p> : null}
        </section>
      ) : null}
    </section>
  );
}

function browseTypesFor(library: JellyfinLibrary, node: BrowseNode | undefined): string {
  if (node?.type === "Series") {
    return "Season";
  }

  if (node?.type === "Season") {
    return "Episode";
  }

  if (node?.type === "Folder" || node?.type === "BoxSet") {
    return "Folder,Series,Season,BoxSet,Movie,Episode";
  }

  switch (library.collectionType) {
    case "movies":
      return "Movie";
    case "tvshows":
      return "Series";
    case "boxsets":
      return "BoxSet";
    default:
      return "Folder,Series,Season,BoxSet,Movie,Episode";
  }
}

function browseLabel(library: JellyfinLibrary, node: BrowseNode | undefined): string {
  if (node) {
    return `Browsing ${node.name}`;
  }

  switch (library.collectionType) {
    case "tvshows":
      return "Choose a series";
    case "boxsets":
      return "Choose a collection";
    default:
      return `Browsing ${library.name}`;
  }
}

function isPlayable(item: JellyfinItem): boolean {
  return playableTypes.has(item.type);
}

function isContainer(item: JellyfinItem): boolean {
  return containerTypes.has(item.type);
}

function shouldRenderPlayableRow(item: JellyfinItem, context: {
  isEpisodeLevel: boolean;
  isMovieList: boolean;
}): boolean {
  return (context.isEpisodeLevel && item.type === "Episode")
    || (context.isMovieList && item.type === "Movie");
}

function episodeParentIndexNumber(node: BrowseNode | undefined): number | undefined {
  if (node?.type !== "Season" || typeof node.indexNumber !== "number") {
    return undefined;
  }

  return node.indexNumber;
}

function filterSeasonEpisodes(items: JellyfinItem[], node: BrowseNode | undefined): JellyfinItem[] {
  const seasonNumber = episodeParentIndexNumber(node);

  if (seasonNumber === undefined) {
    return [...items];
  }

  return items.filter((item) => item.type !== "Episode" || item.parentIndexNumber === undefined || item.parentIndexNumber === seasonNumber);
}

function compareEpisodes(left: JellyfinItem, right: JellyfinItem): number {
  return compareNullableNumber(left.parentIndexNumber, right.parentIndexNumber)
    || compareNullableNumber(left.indexNumber, right.indexNumber)
    || left.name.localeCompare(right.name);
}

function compareNullableNumber(left: number | null | undefined, right: number | null | undefined): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  if (typeof left === "number") {
    return -1;
  }

  if (typeof right === "number") {
    return 1;
  }

  return 0;
}
