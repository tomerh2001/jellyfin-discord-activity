const ROUTE_PARAMETERS: Record<string, ReadonlySet<string>> = {
  home: new Set(["serverId", "tab"]),
  details: new Set(["serverId", "id", "context"]),
  movies: new Set(["serverId", "topParentId", "collectionType", "tab"]),
  tv: new Set(["serverId", "topParentId", "collectionType", "tab"]),
  music: new Set(["serverId", "topParentId", "collectionType", "tab"]),
  list: new Set(["serverId", "parentId", "topParentId", "type", "sortBy", "sortOrder", "startIndex"]),
  search: new Set(["serverId", "parentId", "collectionType", "query"])
};

/** A browsing checkpoint is never an API URL, credential, or playback command. */
export function normalizeNativeRoute(value: unknown, serverId: string): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const match = /^#\/([a-z]+)(?:\?([^#]*))?$/.exec(value);
  const route = match?.[1];
  if (!route || !Object.hasOwn(ROUTE_PARAMETERS, route)) return null;
  const allowed = ROUTE_PARAMETERS[route]!;
  const params = new URLSearchParams(match[2]);
  const seen = new Set<string>();
  for (const [key, part] of params) {
    if (!allowed.has(key) || seen.has(key)) return null;
    seen.add(key);
    if (key === "serverId") { if (part !== serverId) return null; }
    else if (["id", "parentId", "topParentId"].includes(key)) { if (!/^[a-f0-9]{32}$/i.test(part)) return null; }
    else if (["tab", "startIndex"].includes(key)) { if (!/^\d{1,6}$/.test(part)) return null; }
    else if (key === "collectionType") { if (!["movies", "tvshows", "music", "musicvideos", "homevideos", "books", "boxsets", "playlists"].includes(part)) return null; }
    else if (key === "context") { if (!["home", "tvshows", "folders", "movies", "music"].includes(part)) return null; }
    else if (key === "type") { if (!["Movie", "Series", "Episode", "MusicAlbum", "Audio", "BoxSet", "Folder"].includes(part)) return null; }
    else if (key === "sortOrder") { if (!["Ascending", "Descending"].includes(part)) return null; }
    else if (key === "sortBy") { if (!/^[A-Za-z,]{1,100}$/.test(part)) return null; }
    else if (key === "query") {
      if (part.length > 160 || /[<>\\/#?&=:%]/u.test(part)
        || [...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
    }
  }
  if (route === "details" && !params.has("id")) return null;
  const query = params.toString();
  return `#/${route}${query ? `?${query}` : ""}`;
}
