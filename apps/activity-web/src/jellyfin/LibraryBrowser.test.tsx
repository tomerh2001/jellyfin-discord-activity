import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryBrowser } from "./LibraryBrowser.js";

describe("LibraryBrowser", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("drills from TV library to series, season, and episode selection", async () => {
    const onSelectMedia = vi.fn();
    const requestedUrls: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      requestedUrls.push(url);

      if (url.endsWith("/api/jellyfin/libraries")) {
        return jsonResponse({
          libraries: [{
            id: "tv",
            name: "TV",
            collectionType: "tvshows"
          }]
        });
      }

      if (url.includes("/api/jellyfin/items?")) {
        const parsed = new URL(url, "http://localhost");
        const parentId = parsed.searchParams.get("parentId");

        if (parentId === "tv") {
          expect(parsed.searchParams.get("type")).toBe("Series");
          expect(parsed.searchParams.get("recursive")).toBe("false");
          return jsonResponse({
            items: [{
              id: "series-1",
              name: "Example Series",
              type: "Series"
            }],
            totalRecordCount: 1
          });
        }

        if (parentId === "series-1") {
          expect(parsed.searchParams.get("type")).toBe("Season");
          expect(parsed.searchParams.get("recursive")).toBe("false");
          return jsonResponse({
            items: [{
              id: "season-1",
              name: "Season 1",
              type: "Season"
            }],
            totalRecordCount: 1
          });
        }

        if (parentId === "season-1") {
          expect(parsed.searchParams.get("type")).toBe("Episode");
          expect(parsed.searchParams.get("recursive")).toBe("false");
          return jsonResponse({
            items: [{
              id: "episode-1",
              name: "Pilot",
              type: "Episode",
              seriesName: "Example Series",
              seasonName: "Season 1"
            }],
            totalRecordCount: 1
          });
        }
      }

      if (url.endsWith("/api/jellyfin/items/episode-1")) {
        return jsonResponse({
          item: {
            id: "episode-1",
            name: "Pilot",
            type: "Episode",
            seriesName: "Example Series",
            seasonName: "Season 1"
          }
        });
      }

      return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
    }));

    render(
      <LibraryBrowser
        appToken="app-token"
        canSelectMedia
        onSelectMedia={onSelectMedia}
        selectedItemId={undefined}
      />
    );

    await screen.findByText("Example Series");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await screen.findByText("Season 1");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await screen.findByText("Pilot");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    await waitFor(() => {
      expect(onSelectMedia).toHaveBeenCalledWith(expect.objectContaining({
        id: "episode-1",
        type: "Episode"
      }));
    });
    expect(requestedUrls.some((url) => url.includes("recursive=false"))).toBe(true);
  });

  it("renders episode drill-down as an ordered list filtered to the selected season", async () => {
    const onSelectMedia = vi.fn();
    const requestedParentIndexes: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/jellyfin/libraries")) {
        return jsonResponse({
          libraries: [{
            id: "tv",
            name: "TV",
            collectionType: "tvshows"
          }]
        });
      }

      if (url.includes("/api/jellyfin/items?")) {
        const parsed = new URL(url, "http://localhost");
        const parentId = parsed.searchParams.get("parentId");

        if (parentId === "tv") {
          return jsonResponse({
            items: [{
              id: "series-1",
              name: "Example Series",
              type: "Series"
            }],
            totalRecordCount: 1
          });
        }

        if (parentId === "series-1") {
          return jsonResponse({
            items: [{
              id: "season-specials",
              name: "Specials",
              type: "Season",
              indexNumber: 0
            }, {
              id: "season-1",
              name: "Season 1",
              type: "Season",
              indexNumber: 1
            }],
            totalRecordCount: 2
          });
        }

        if (parentId === "season-1") {
          requestedParentIndexes.push(parsed.searchParams.get("parentIndexNumber") ?? "");

          return jsonResponse({
            items: [{
              id: "episode-special",
              name: "Special Episode",
              type: "Episode",
              overview: "A special story.",
              seasonName: "Specials",
              parentIndexNumber: 0,
              indexNumber: 1
            }, {
              id: "episode-2",
              name: "Second Episode",
              type: "Episode",
              overview: "The second story.",
              seasonName: "Season 1",
              parentIndexNumber: 1,
              indexNumber: 2,
              runtimeTicks: 3_662_000_000
            }, {
              id: "episode-1",
              name: "First Episode",
              type: "Episode",
              overview: "The first story.",
              seasonName: "Season 1",
              parentIndexNumber: 1,
              indexNumber: 1,
              runtimeTicks: 3_661_000_000
            }],
            totalRecordCount: 2
          });
        }
      }

      return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
    }));

    const { container } = render(
      <LibraryBrowser
        appToken="app-token"
        canSelectMedia
        onSelectMedia={onSelectMedia}
        selectedItemId={undefined}
      />
    );

    await screen.findByText("Example Series");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await screen.findByText("Season 1");
    const seasonOpenButtons = screen.getAllByRole("button", { name: "Open" });
    expect(seasonOpenButtons).toHaveLength(2);
    fireEvent.click(seasonOpenButtons[1]!);

    await screen.findByText("First Episode");
    expect(screen.getByText("The first story.")).toBeInTheDocument();
    expect(screen.getAllByText("Season 1").length).toBeGreaterThan(0);
    expect(screen.getByText("Episode 1")).toBeInTheDocument();
    expect(screen.getAllByText("Runtime: 00:06:06").length).toBeGreaterThan(0);
    expect(screen.queryByText("Special Episode")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Library view" })).not.toBeInTheDocument();
    expect(requestedParentIndexes).toEqual(["1"]);

    const titles = Array.from(container.querySelectorAll(".playable-row h3")).map((node) => node.textContent);
    expect(titles).toEqual(["First Episode", "Second Episode"]);
  });

  it("renders movie libraries as playable rows with runtime", async () => {
    const onSelectMedia = vi.fn();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/jellyfin/libraries")) {
        return jsonResponse({
          libraries: [{
            id: "movies",
            name: "Movies",
            collectionType: "movies"
          }]
        });
      }

      if (url.includes("/api/jellyfin/items?")) {
        const parsed = new URL(url, "http://localhost");
        expect(parsed.searchParams.get("parentId")).toBe("movies");
        expect(parsed.searchParams.get("type")).toBe("Movie");
        expect(parsed.searchParams.get("recursive")).toBe("false");

        return jsonResponse({
          items: [{
            id: "movie-1",
            name: "Example Movie",
            type: "Movie",
            overview: "A movie overview.",
            productionYear: 2026,
            runtimeTicks: 73_840_000_000
          }],
          totalRecordCount: 1
        });
      }

      return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
    }));

    const { container } = render(
      <LibraryBrowser
        appToken="app-token"
        canSelectMedia
        onSelectMedia={onSelectMedia}
        selectedItemId={undefined}
      />
    );

    await screen.findByText("Example Movie");
    expect(screen.getByText("A movie overview.")).toBeInTheDocument();
    expect(screen.getByText("Runtime: 02:03:04")).toBeInTheDocument();
    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Library view" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".playable-row")).toHaveLength(1);
  });

  it("drills from collection library to playable item selection", async () => {
    const onSelectMedia = vi.fn();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/jellyfin/libraries")) {
        return jsonResponse({
          libraries: [{
            id: "collections",
            name: "Collections",
            collectionType: "boxsets"
          }]
        });
      }

      if (url.includes("/api/jellyfin/items?")) {
        const parsed = new URL(url, "http://localhost");
        const parentId = parsed.searchParams.get("parentId");

        if (parentId === "collections") {
          expect(parsed.searchParams.get("type")).toBe("BoxSet");
          return jsonResponse({
            items: [{
              id: "collection-1",
              name: "Movie Collection",
              type: "BoxSet"
            }],
            totalRecordCount: 1
          });
        }

        if (parentId === "collection-1") {
          expect(parsed.searchParams.get("type")).toBe("Folder,Series,Season,BoxSet,Movie,Episode");
          return jsonResponse({
            items: [{
              id: "movie-1",
              name: "Collection Movie",
              type: "Movie"
            }],
            totalRecordCount: 1
          });
        }
      }

      if (url.endsWith("/api/jellyfin/items/movie-1")) {
        return jsonResponse({
          item: {
            id: "movie-1",
            name: "Collection Movie",
            type: "Movie"
          }
        });
      }

      return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
    }));

    render(
      <LibraryBrowser
        appToken="app-token"
        canSelectMedia
        onSelectMedia={onSelectMedia}
        selectedItemId={undefined}
      />
    );

    await screen.findByText("Movie Collection");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await screen.findByText("Collection Movie");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    await waitFor(() => {
      expect(onSelectMedia).toHaveBeenCalledWith(expect.objectContaining({
        id: "movie-1",
        type: "Movie"
      }));
    });
  });

  it("loads additional pages when a TV library has more than 100 series", async () => {
    const onSelectMedia = vi.fn();
    const requestedStarts: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/jellyfin/libraries")) {
        return jsonResponse({
          libraries: [{
            id: "anime-tv",
            name: "Anime - TV",
            collectionType: "tvshows"
          }]
        });
      }

      if (url.includes("/api/jellyfin/items?")) {
        const parsed = new URL(url, "http://localhost");
        requestedStarts.push(parsed.searchParams.get("startIndex") ?? "");
        expect(parsed.searchParams.get("parentId")).toBe("anime-tv");
        expect(parsed.searchParams.get("type")).toBe("Series");
        expect(parsed.searchParams.get("recursive")).toBe("false");
        expect(parsed.searchParams.get("limit")).toBe("100");

        if (parsed.searchParams.get("startIndex") === "100") {
          return jsonResponse({
            items: [{
              id: "series-101",
              name: "Series 101",
              type: "Series"
            }],
            totalRecordCount: 311
          });
        }

        return jsonResponse({
          items: Array.from({ length: 100 }, (_, index) => ({
            id: `series-${index + 1}`,
            name: `Series ${index + 1}`,
            type: "Series"
          })),
          totalRecordCount: 311
        });
      }

      return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
    }));

    render(
      <LibraryBrowser
        appToken="app-token"
        canSelectMedia
        onSelectMedia={onSelectMedia}
        selectedItemId={undefined}
      />
    );

    await screen.findByText("Series 100");
    fireEvent.click(screen.getByRole("button", { name: "Load more (100 of 311)" }));

    await screen.findByText("Series 101");
    expect(requestedStarts).toContain("0");
    expect(requestedStarts).toContain("100");
  });

  it("searches TV libraries for matching series and matching episodes", async () => {
    const onSelectMedia = vi.fn();

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/jellyfin/libraries")) {
        return jsonResponse({
          libraries: [{
            id: "anime-tv",
            name: "Anime - TV",
            collectionType: "tvshows"
          }]
        });
      }

      if (url.includes("/api/jellyfin/items?")) {
        const parsed = new URL(url, "http://localhost");

        if (parsed.searchParams.get("query") === "Evangelion") {
          expect(parsed.searchParams.get("parentId")).toBe("anime-tv");
          expect(parsed.searchParams.get("type")).toBe("Series,BoxSet,Movie,Episode");
          expect(parsed.searchParams.get("recursive")).toBe("true");

          return jsonResponse({
            items: [{
              id: "series-evangelion",
              name: "Neon Genesis Evangelion",
              type: "Series"
            }, {
              id: "episode-evangelion-special",
              name: "Evangelion Special",
              type: "Episode",
              seriesName: "Neon Genesis Evangelion",
              seasonName: "Specials"
            }],
            totalRecordCount: 2
          });
        }

        return jsonResponse({
          items: [{
            id: "series-other",
            name: "Other Series",
            type: "Series"
          }],
          totalRecordCount: 1
        });
      }

      return jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404);
    }));

    render(
      <LibraryBrowser
        appToken="app-token"
        canSelectMedia
        onSelectMedia={onSelectMedia}
        selectedItemId={undefined}
      />
    );

    await screen.findByText("Other Series");
    fireEvent.change(screen.getByLabelText("Search"), {
      target: {
        value: "Evangelion"
      }
    });

    await screen.findByText("Neon Genesis Evangelion");
    await screen.findByText("Evangelion Special");
    expect(screen.getAllByText("Series").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Episode").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
