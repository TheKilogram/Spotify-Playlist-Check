import { GameTrack } from '../types';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const SESSION_KEY = 'playlist-detector.spotify-session.v1';
const PKCE_KEY = 'playlist-detector.spotify-pkce.v1';
const EXPIRY_BUFFER_MS = 60_000;

const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-library-modify',
];

export interface SpotifySession {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope: string;
  expiresAt: number;
}

interface SpotifyPage<T> {
  items: T[];
  next: string | null;
}

interface PkceState {
  verifier: string;
  state: string;
  redirectUri: string;
}

export function getSpotifyRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function loadStoredSpotifySession(): SpotifySession | null {
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SpotifySession;
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearSpotifySession() {
  window.localStorage.removeItem(SESSION_KEY);
}

function persistSpotifySession(session: SpotifySession) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function getPkceState() {
  const raw = window.localStorage.getItem(PKCE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PkceState;
  } catch {
    window.localStorage.removeItem(PKCE_KEY);
    return null;
  }
}

function clearPkceState() {
  window.localStorage.removeItem(PKCE_KEY);
}

function toUrlSafeBase64(buffer: ArrayBuffer) {
  return window
    .btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createRandomString(length: number) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = window.crypto.getRandomValues(new Uint8Array(length));

  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join(
    '',
  );
}

async function createCodeChallenge(verifier: string) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', encoded);
  return toUrlSafeBase64(digest);
}

export async function beginSpotifyLogin(clientId: string) {
  const verifier = createRandomString(96);
  const state = createRandomString(24);
  const redirectUri = getSpotifyRedirectUri();
  const challenge = await createCodeChallenge(verifier);

  window.localStorage.setItem(
    PKCE_KEY,
    JSON.stringify({
      verifier,
      state,
      redirectUri,
    } satisfies PkceState),
  );

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });

  window.location.assign(`${AUTH_URL}?${params.toString()}`);
}

function buildSession(payload: {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope: string;
  expires_in: number;
}) {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    tokenType: payload.token_type,
    scope: payload.scope,
    expiresAt: Date.now() + payload.expires_in * 1000,
  } satisfies SpotifySession;
}

async function requestToken(body: URLSearchParams) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Spotify auth failed: ${errorText}`);
  }

  return (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    scope: string;
    expires_in: number;
  };
}

export async function handleSpotifyRedirect(clientId: string) {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (!code && !error) {
    return null;
  }

  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  window.history.replaceState({}, document.title, url.toString());

  if (error) {
    clearPkceState();
    throw new Error(`Spotify sign-in was cancelled: ${error}`);
  }

  const pkceState = getPkceState();
  if (!pkceState || pkceState.state !== state) {
    clearPkceState();
    throw new Error('Spotify sign-in state did not match the current browser session.');
  }

  if (!code) {
    clearPkceState();
    throw new Error('Spotify sign-in callback did not include an authorization code.');
  }

  const tokenPayload = await requestToken(
    new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: pkceState.redirectUri,
      code_verifier: pkceState.verifier,
    }),
  );

  const session = buildSession(tokenPayload);
  persistSpotifySession(session);
  clearPkceState();
  return session;
}

export async function refreshSpotifySession(clientId: string) {
  const current = loadStoredSpotifySession();
  if (!current?.refreshToken) {
    clearSpotifySession();
    return null;
  }

  const tokenPayload = await requestToken(
    new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    }),
  );

  const session = {
    ...buildSession(tokenPayload),
    refreshToken: tokenPayload.refresh_token ?? current.refreshToken,
  } satisfies SpotifySession;

  persistSpotifySession(session);
  return session;
}

export async function getFreshSpotifySession(clientId: string) {
  const current = loadStoredSpotifySession();
  if (!current) {
    return null;
  }

  if (current.expiresAt - Date.now() > EXPIRY_BUFFER_MS) {
    return current;
  }

  return refreshSpotifySession(clientId);
}

async function parseSpotifyError(response: Response) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message ?? payload?.error_description;
    return message ? String(message) : response.statusText;
  } catch {
    return response.statusText;
  }
}

export async function spotifyRequest<T>(
  accessToken: string,
  endpoint: string,
  init?: RequestInit,
) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const errorMessage = await parseSpotifyError(response);
    throw new Error(`Spotify API error (${response.status}): ${errorMessage}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function getAllSpotifyItems<T>(accessToken: string, endpoint: string) {
  const items: T[] = [];
  let nextUrl: string | null = endpoint;

  while (nextUrl) {
    const page: SpotifyPage<T> = await spotifyRequest<SpotifyPage<T>>(
      accessToken,
      nextUrl,
    );
    items.push(...page.items);
    nextUrl = page.next;
  }

  return items;
}

export async function getCurrentUserProfile(accessToken: string) {
  return spotifyRequest<{
    display_name: string | null;
    id: string;
  }>(accessToken, '/me');
}

export async function getCurrentUserPlaylists(accessToken: string) {
  return getAllSpotifyItems<{
    id: string;
    name: string;
    description: string | null;
    images?: Array<{ url: string }>;
    owner?: { display_name?: string | null };
    tracks?: { total?: number };
  }>(accessToken, '/me/playlists?limit=50');
}

export async function getSavedTrackItems(accessToken: string) {
  return getAllSpotifyItems<{ track: SpotifyApiTrack | null }>(
    accessToken,
    '/me/tracks?limit=50',
  );
}

export async function getPlaylistTrackItems(
  accessToken: string,
  playlistId: string,
) {
  return getAllSpotifyItems<{ track: SpotifyApiTrack | null }>(
    accessToken,
    `/playlists/${playlistId}/tracks?limit=50&additional_types=track`,
  );
}

export async function searchSpotifyTracks(
  accessToken: string,
  query: string,
) {
  const params = new URLSearchParams({
    q: query,
    type: 'track',
    limit: '10',
  });

  const payload = await spotifyRequest<{
    tracks: { items: SpotifyApiTrack[] };
  }>(accessToken, `/search?${params.toString()}`);

  return payload.tracks.items;
}

export async function addTrackToPlaylist(
  accessToken: string,
  playlistId: string,
  spotifyUri: string,
) {
  await spotifyRequest<void>(accessToken, `/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris: [spotifyUri] }),
  });
}

export async function saveTrackToLibrary(accessToken: string, trackId: string) {
  const params = new URLSearchParams({
    ids: trackId,
  });

  await spotifyRequest<void>(accessToken, `/me/tracks?${params.toString()}`, {
    method: 'PUT',
  });
}

interface SpotifyApiTrack {
  id: string | null;
  name: string;
  uri: string | null;
  is_local?: boolean;
  external_urls?: { spotify?: string };
  artists?: Array<{ name?: string | null }>;
  album?: {
    name?: string | null;
    images?: Array<{ url: string }>;
  };
}

export function mapSpotifyTrack(
  trackLike: SpotifyApiTrack | { track: SpotifyApiTrack | null } | null,
  source: GameTrack['source'],
): GameTrack | null {
  const track =
    trackLike && 'track' in trackLike ? trackLike.track : (trackLike as SpotifyApiTrack | null);

  if (!track || track.is_local || !track.id || !track.uri) {
    return null;
  }

  const artistNames = (track.artists ?? [])
    .map((artist) => artist.name?.trim())
    .filter((name): name is string => Boolean(name));

  if (!artistNames.length) {
    return null;
  }

  return {
    id: track.id,
    name: track.name,
    artistNames,
    artistLine: artistNames.join(', '),
    albumName: track.album?.name?.trim() ?? 'Unknown album',
    albumImageUrl: track.album?.images?.[0]?.url ?? null,
    spotifyUri: track.uri,
    spotifyUrl:
      track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
    source,
  };
}
