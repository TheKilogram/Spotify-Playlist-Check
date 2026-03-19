import { GameTrack, LastFmCandidate } from '../types';

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const JSONP_TIMEOUT_MS = 12_000;

function toArray<T>(value: T | T[] | undefined) {
  if (!value) {
    return [] as T[];
  }

  return Array.isArray(value) ? value : [value];
}

function sanitize(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function buildKey(artist: string, track: string) {
  return `${artist.toLowerCase()}::${track.toLowerCase()}`;
}

function jsonp<T>(params: Record<string, string | number>) {
  return new Promise<T>((resolve, reject) => {
    const callbackName = `__lastfm_${window.crypto.randomUUID().replace(/-/g, '')}`;
    const callbackStore = window as unknown as Record<string, unknown>;
    const script = document.createElement('script');
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Last.fm request timed out.'));
    }, JSONP_TIMEOUT_MS);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      delete callbackStore[callbackName];
      script.remove();
    };

    callbackStore[callbackName] = (payload: T) => {
      cleanup();
      resolve(payload);
    };

    const query = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      ),
      format: 'json',
      callback: callbackName,
    });

    script.src = `${LASTFM_API_URL}?${query.toString()}`;
    script.async = true;
    script.onerror = () => {
      cleanup();
      reject(new Error('Last.fm request failed to load.'));
    };

    document.body.appendChild(script);
  });
}

function collectCandidate(
  map: Map<string, LastFmCandidate>,
  artist: string,
  track: string,
  source: string,
  seedTrack: GameTrack,
) {
  const cleanArtist = sanitize(artist);
  const cleanTrack = sanitize(track);
  if (!cleanArtist || !cleanTrack) {
    return;
  }

  const sameArtist = cleanArtist.toLowerCase() === seedTrack.artistNames[0].toLowerCase();
  const sameTrack = cleanTrack.toLowerCase() === seedTrack.name.toLowerCase();
  if (sameArtist && sameTrack) {
    return;
  }

  map.set(buildKey(cleanArtist, cleanTrack), {
    artist: cleanArtist,
    track: cleanTrack,
    source,
  });
}

export async function getLastFmRecommendations(
  apiKey: string,
  seedTrack: GameTrack,
) {
  const candidates = new Map<string, LastFmCandidate>();
  const primaryArtist = seedTrack.artistNames[0];

  try {
    const trackResponse = await jsonp<{
      similartracks?: {
        track?: Array<{
          name?: string;
          artist?: { name?: string };
        }> | {
          name?: string;
          artist?: { name?: string };
        };
      };
    }>({
      method: 'track.getSimilar',
      api_key: apiKey,
      artist: primaryArtist,
      track: seedTrack.name,
      autocorrect: 1,
      limit: 18,
    });

    for (const match of toArray(trackResponse.similartracks?.track)) {
      collectCandidate(
        candidates,
        match.artist?.name ?? '',
        match.name ?? '',
        'track.getSimilar',
        seedTrack,
      );
    }
  } catch {
    // Ignore and fall back to artist-based discovery.
  }

  if (candidates.size >= 8) {
    return Array.from(candidates.values());
  }

  try {
    const artistResponse = await jsonp<{
      similarartists?: {
        artist?: Array<{ name?: string }> | { name?: string };
      };
    }>({
      method: 'artist.getSimilar',
      api_key: apiKey,
      artist: primaryArtist,
      autocorrect: 1,
      limit: 8,
    });

    const similarArtists = toArray(artistResponse.similarartists?.artist)
      .map((artist) => sanitize(artist.name ?? ''))
      .filter(Boolean)
      .slice(0, 4);

    const topTrackResponses = await Promise.allSettled(
      similarArtists.map((artist) =>
        jsonp<{
          toptracks?: {
            track?: Array<{ name?: string; artist?: { name?: string } }>;
          };
        }>({
          method: 'artist.getTopTracks',
          api_key: apiKey,
          artist,
          autocorrect: 1,
          limit: 6,
        }),
      ),
    );

    topTrackResponses.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        return;
      }

      const artistName = similarArtists[index];
      for (const match of toArray(result.value.toptracks?.track)) {
        collectCandidate(
          candidates,
          match.artist?.name ?? artistName,
          match.name ?? '',
          `artist.getTopTracks:${artistName}`,
          seedTrack,
        );
      }
    });
  } catch {
    // Return the candidates collected so far.
  }

  return Array.from(candidates.values());
}
