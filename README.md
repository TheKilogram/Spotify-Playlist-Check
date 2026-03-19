# Spotify Playlist Detector

A static GitHub Pages app that signs into Spotify, lets you choose one playlist or Liked Songs, and turns playlist membership into a fast guessing game.

## What it does

- Uses Spotify PKCE auth directly in the browser, so it can run on GitHub Pages without a custom backend.
- Loads your playlists plus a synthetic `Liked Songs` option.
- Runs a 50/50 round generator:
  - one branch picks a random track already in the active collection
  - the other branch asks Last.fm for similar music, searches Spotify for matches, and rerolls until it finds a track that is not already in the active collection
- Shows the track title, album art, artist, and a Spotify embed.
- Scores `Correct`, `Wrong`, `Fresh finds`, and `Added`.
- Lets you add off-list discoveries back to the active playlist or save them to Liked Songs.
- Includes 5 deliberately different UI directions so you can choose the final visual direction later.

## Local setup

1. Create a Spotify app in the Spotify developer dashboard.
2. Add your local redirect URI:
   - `https://localhost:5173/`
3. Add your deployed GitHub Pages redirect URI after you know the final URL.
4. Get a Last.fm API key.
5. Install dependencies:

```bash
npm install
```

6. Start the dev server:

```bash
npm run dev
```

Set the environment variables before building or running locally:

```bash
VITE_SPOTIFY_CLIENT_ID=your_spotify_client_id
VITE_LASTFM_API_KEY=your_lastfm_api_key
```

Local dev now runs on `https://localhost:5173/` with Vite's self-signed certificate support.

## GitHub Pages deployment

The repo includes a GitHub Actions workflow at [.github/workflows/deploy.yml](/Users/kilodev/Projects/Spotify-Apps/Playlist-Test/.github/workflows/deploy.yml) that builds `dist/` and deploys it to Pages on pushes to `main`.

For a clean hosted setup, add these repository secrets:

- `VITE_SPOTIFY_CLIENT_ID`
- `VITE_LASTFM_API_KEY`

Then add your final Pages URL as an allowed redirect URI in the Spotify app settings. It must match exactly, for example:

- `https://your-user-name.github.io/Playlist-Test/`

## Notes

- End users do not need to bring their own API keys. The site owner provides the Spotify client ID and Last.fm key at build time.
- Spotify authentication is handled in-browser with PKCE. The Spotify client ID is public by design; the client secret is not used in this app.
- A Last.fm key used directly from a browser build is exposed to the client. If you want to keep it secret, you need a small proxy or serverless function instead of pure GitHub Pages only.
- Spotify API behavior for some followed playlists can vary depending on the playlist and your account permissions. The app includes them in the selector and will surface API errors if Spotify blocks track access for a specific playlist.
- Last.fm lookups are done client-side in a browser-safe JSONP flow because this app is designed to work without a backend.
