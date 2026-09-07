export const discordCommands = [
  { name: "watch", description: "Open the Jellyfin watch party in this channel", type: 1 },
  { name: "Watch Jellyfin", type: 2 },
  { name: "Watch Jellyfin", type: 3 },
  {
    name: "jellyfin", description: "Control your voice channel's Jellyfin watch party", type: 1,
    options: [
      { name: "play", description: "Find a movie or episode to watch", type: 1, options: [
        { name: "query", description: "Movie or episode title", type: 3, required: true, min_length: 1, max_length: 200 }
      ] },
      { name: "pause", description: "Pause playback (host only)", type: 1 },
      { name: "resume", description: "Resume playback (host only)", type: 1 },
      { name: "seek", description: "Jump to a position and pause (host only)", type: 1, options: [
        { name: "seconds", description: "Position in seconds", type: 10, required: true, min_value: 0, max_value: 86400 }
      ] },
      { name: "stop", description: "Pause and return to the start (host only)", type: 1 },
      { name: "now", description: "Show the current movie or episode", type: 1 }
    ]
  }
].map((command) => ({ ...command, contexts: [0], integration_types: [0] }));
