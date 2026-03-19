import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addTrackToPlaylist,
  beginSpotifyLogin,
  clearSpotifySession,
  getCurrentUserPlaylists,
  getCurrentUserProfile,
  getFreshSpotifySession,
  getPlaylistTrackItems,
  getSavedTrackItems,
  getSavedTracksTotal,
  getUserPlaylists,
  handleSpotifyRedirect,
  loadStoredSpotifySession,
  mapSpotifyTrack,
  pausePlayback,
  playTrackOnDevice,
  refreshSpotifySession,
  saveTrackToLibrary,
  searchSpotifyTracks,
  SpotifySession,
  transferPlayback,
} from './lib/spotify';
import { getLastFmRecommendations } from './lib/lastfm';
import {
  ensureSpotifyWebPlaybackSdk,
  SpotifyPlayerInstance,
  SpotifyWebPlaybackState,
} from './lib/webPlayback';
import {
  AppConfig,
  CollectionState,
  CollectionSummary,
  GameRound,
  GameTrack,
  ScoreBoard,
} from './types';

const MAX_RECENT_TRACKS = 20;

const EMPTY_SCORE: ScoreBoard = {
  correct: 0,
  incorrect: 0,
  newFinds: 0,
  added: 0,
};

const envConfig: AppConfig = {
  spotifyClientId: import.meta.env.VITE_SPOTIFY_CLIENT_ID?.trim() ?? '',
  lastFmApiKey: import.meta.env.VITE_LASTFM_API_KEY?.trim() ?? '',
};

function dedupeTracks(tracks: GameTrack[]) {
  return Array.from(new Map(tracks.map((track) => [track.id, track])).values());
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function pickRandomTrack(pool: GameTrack[], recentIds: string[]) {
  if (!pool.length) {
    return null;
  }

  const recentSet = new Set(recentIds);
  const filtered = pool.filter((track) => !recentSet.has(track.id));
  const candidates = filtered.length ? filtered : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function shuffle<T>(items: T[]) {
  const next = [...items];

  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }

  return next;
}

function appendRecentTrack(recentIds: string[], trackId: string) {
  const next = [...recentIds.filter((id) => id !== trackId), trackId];
  return next.slice(-MAX_RECENT_TRACKS);
}

function buildSpotifySearchQuery(candidate: { artist: string; track: string }) {
  return `track:"${candidate.track}" artist:"${candidate.artist}"`;
}

function trimText(value: string, fallback: string) {
  const cleaned = value.replace(/<[^>]+>/g, '').trim();
  return cleaned || fallback;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function normalizeSongFragment(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(([^)]*(remaster|deluxe|mono|stereo|version|edit|mix|live|acoustic)[^)]*)\)/g, ' ')
    .replace(/\[([^\]]*(remaster|deluxe|mono|stereo|version|edit|mix|live|acoustic)[^\]]*)\]/g, ' ')
    .replace(/\s[-:]\s(.*\b(remaster|deluxe|mono|stereo|version|edit|mix|live|acoustic)\b.*)$/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTrackKey(track: Pick<GameTrack, 'name' | 'artistNames'>) {
  const normalizedTitle = normalizeSongFragment(track.name);
  const normalizedArtist = normalizeSongFragment(track.artistNames[0] ?? '');
  return `${normalizedTitle}::${normalizedArtist}`;
}

function sameSession(
  left: SpotifySession | null,
  right: SpotifySession | null,
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.expiresAt === right.expiresAt &&
    left.scope === right.scope &&
    left.tokenType === right.tokenType
  );
}

function resultLabel(round: GameRound | null) {
  if (!round?.revealed) {
    return null;
  }

  if (round.isCorrect) {
    return round.isOnList ? 'Correct. It was already on your list.' : 'Correct. Fresh find.';
  }

  return round.isOnList
    ? 'Nope. That track was already on your list.'
    : 'Nope. This one was not on your list yet.';
}

async function buildCollectionState(
  session: SpotifySession,
  collection: CollectionSummary,
) {
  let rawItems;

  try {
    rawItems =
      collection.kind === 'liked'
        ? await getSavedTrackItems(session.accessToken)
        : await getPlaylistTrackItems(session.accessToken, collection.id);
  } catch (error) {
    if (
      collection.kind === 'playlist' &&
      error instanceof Error &&
      error.message.includes('Spotify API error (403)')
    ) {
      throw new Error(
        `Spotify blocked track access for "${collection.name}". This can happen with some followed or private playlists even if they appear in your library.`,
      );
    }

    throw error;
  }

  const tracks = dedupeTracks(
    rawItems
      .map((item) =>
        mapSpotifyTrack(item, collection.kind === 'liked' ? 'playlist' : 'playlist'),
      )
      .filter((track): track is GameTrack => Boolean(track)),
  );

  return {
    summary: collection,
    tracks,
    trackIds: new Set(tracks.map((track) => track.id)),
    trackKeys: new Set(tracks.map((track) => buildTrackKey(track))),
  } satisfies CollectionState;
}

export default function App() {
  const [session, setSession] = useState<SpotifySession | null>(() =>
    loadStoredSpotifySession(),
  );
  const [isBooting, setIsBooting] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);
  const [isLoadingRound, setIsLoadingRound] = useState(false);
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [collectionState, setCollectionState] = useState<CollectionState | null>(null);
  const [round, setRound] = useState<GameRound | null>(null);
  const [score, setScore] = useState<ScoreBoard>(EMPTY_SCORE);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recentTrackIdsRef = useRef<string[]>([]);
  const spotifyPlayerRef = useRef<SpotifyPlayerInstance | null>(null);
  const [webPlaybackDeviceId, setWebPlaybackDeviceId] = useState<string | null>(null);
  const [webPlaybackState, setWebPlaybackState] = useState<SpotifyWebPlaybackState | null>(
    null,
  );
  const [webPlaybackStatus, setWebPlaybackStatus] = useState<string | null>(null);
  const [isWebPlaybackReady, setIsWebPlaybackReady] = useState(false);
  const [isActivatingPlayback, setIsActivatingPlayback] = useState(false);
  const [playerVolume, setPlayerVolume] = useState(80);

  useEffect(() => {
    document.documentElement.dataset.theme = 'vinyl';
  }, []);

  useEffect(() => {
    let cancelled = false;
    let createdPlayer: SpotifyPlayerInstance | null = null;

    async function setupWebPlayback() {
      if (!session || !envConfig.spotifyClientId) {
        spotifyPlayerRef.current?.disconnect();
        spotifyPlayerRef.current = null;
        setWebPlaybackDeviceId(null);
        setWebPlaybackState(null);
        setIsWebPlaybackReady(false);
        setWebPlaybackStatus(null);
        return;
      }

      if (spotifyPlayerRef.current || !window.isSecureContext) {
        if (!window.isSecureContext) {
          setWebPlaybackStatus('Browser playback requires a secure context.');
        }
        return;
      }

      try {
        await ensureSpotifyWebPlaybackSdk();
        if (cancelled || !window.Spotify) {
          return;
        }

        const player = new window.Spotify.Player({
          name: 'Playlist Detector',
          volume: 0.8,
          getOAuthToken: async (cb) => {
            try {
              const nextSession = await getFreshSpotifySession(envConfig.spotifyClientId);
              if (nextSession?.accessToken) {
                syncSession(nextSession);
                cb(nextSession.accessToken);
                return;
              }
            } catch {
              // Fall back to the session token already in memory.
            }

            cb(session.accessToken);
          },
        });
        createdPlayer = player;

        player.addListener('ready', (payload) => {
          const { device_id: deviceId } = payload as { device_id: string };
          if (cancelled) {
            return;
          }

          spotifyPlayerRef.current = player;
          setWebPlaybackDeviceId(deviceId);
          setIsWebPlaybackReady(true);
          setWebPlaybackStatus(null);
        });

        player.addListener('not_ready', () => {
          if (cancelled) {
            return;
          }

          setIsWebPlaybackReady(false);
          setWebPlaybackStatus('Browser player is temporarily unavailable.');
        });

        player.addListener('player_state_changed', (payload) => {
          if (cancelled) {
            return;
          }

          setWebPlaybackState((payload as SpotifyWebPlaybackState | null) ?? null);
        });

        player.addListener('initialization_error', (payload) => {
          const { message } = payload as { message: string };
          setWebPlaybackStatus(message);
        });

        player.addListener('authentication_error', (payload) => {
          const { message } = payload as { message: string };
          setWebPlaybackStatus(message);
        });

        player.addListener('account_error', () => {
          setWebPlaybackStatus(
            'Browser playback requires Spotify Premium and a supported browser.',
          );
        });

        player.addListener('autoplay_failed', () => {
          setWebPlaybackStatus('Press play once to enable browser audio.');
        });

        const connected = await player.connect();
        if (!connected && !cancelled) {
          setWebPlaybackStatus('Could not connect the browser player.');
        }
      } catch (sdkError) {
        if (!cancelled) {
          setWebPlaybackStatus(
            sdkError instanceof Error ? sdkError.message : 'Browser player failed to start.',
          );
        }
      }
    }

    void setupWebPlayback();

    return () => {
      cancelled = true;
      if (createdPlayer && spotifyPlayerRef.current === createdPlayer) {
        createdPlayer.disconnect();
        spotifyPlayerRef.current = null;
      }
    };
  }, [session]);

  function syncSession(nextSession: SpotifySession | null) {
    setSession((current) => (sameSession(current, nextSession) ? current : nextSession));
  }

  useEffect(() => {
    void bootstrapSession();
    // Env config is fixed at build time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function bootstrapSession() {
    setIsBooting(true);
    setError(null);

    if (!envConfig.spotifyClientId) {
      syncSession(null);
      setIsBooting(false);
      return;
    }

    try {
      const redirectedSession = await handleSpotifyRedirect(envConfig.spotifyClientId);
      if (redirectedSession) {
        syncSession(redirectedSession);
      } else {
        const currentSession = await getFreshSpotifySession(envConfig.spotifyClientId);
        syncSession(currentSession);
      }
    } catch (sessionError) {
      syncSession(null);
      clearSpotifySession();
      setError(
        sessionError instanceof Error
          ? sessionError.message
          : 'Spotify sign-in could not be completed.',
      );
    } finally {
      setIsBooting(false);
    }
  }

  async function withFreshSession<T>(task: (nextSession: SpotifySession) => Promise<T>) {
    if (!envConfig.spotifyClientId) {
      throw new Error('Spotify is not configured for this deployment yet.');
    }

    const nextSession =
      (await getFreshSpotifySession(envConfig.spotifyClientId)) ??
      (await refreshSpotifySession(envConfig.spotifyClientId));

    if (!nextSession) {
      clearSpotifySession();
      syncSession(null);
      throw new Error('Spotify session expired. Sign in again to continue.');
    }

    syncSession(nextSession);
    return task(nextSession);
  }

  async function loadCollections() {
    if (!session) {
      return;
    }

    setIsLoadingCollections(true);
    setError(null);

    try {
      const { profile, playlistItems, likedSongsTotal } = await withFreshSession(
        async (nextSession) => {
          const profile = await getCurrentUserProfile(nextSession.accessToken);
          const [libraryPlaylists, profilePlaylists, likedSongsTotal] =
            await Promise.all([
              getCurrentUserPlaylists(nextSession.accessToken),
              getUserPlaylists(nextSession.accessToken, profile.id).catch(() => []),
              getSavedTracksTotal(nextSession.accessToken),
            ]);

          return {
            profile,
            playlistItems: dedupeById([...libraryPlaylists, ...profilePlaylists]),
            likedSongsTotal,
          };
        },
      );

      setProfileName(profile.display_name?.trim() || profile.id);

      const playlistCollections = playlistItems.map((playlist) => ({
        id: playlist.id,
        kind: 'playlist',
        name: trimText(playlist.name, 'Untitled playlist'),
        description: trimText(
          playlist.description ?? '',
          'A Spotify playlist from your library.',
        ),
        imageUrl: playlist.images?.[0]?.url ?? null,
        ownerName: playlist.owner?.display_name?.trim() || 'Spotify user',
        trackCount: playlist.items?.total ?? playlist.tracks?.total ?? 0,
      })) satisfies CollectionSummary[];

      const likedSongsCollection: CollectionSummary = {
        id: 'liked-songs',
        kind: 'liked',
        name: 'Liked Songs',
        description: 'Everything you have saved to your Spotify library.',
        imageUrl: null,
        ownerName: profile.display_name?.trim() || profile.id,
        trackCount: likedSongsTotal,
      };

      const nextCollections: CollectionSummary[] = [
        likedSongsCollection,
        ...playlistCollections,
      ];

      setCollections(nextCollections);
      setSelectedCollectionId((current) =>
        current && nextCollections.some((collection) => collection.id === current)
          ? current
          : nextCollections[0]?.id ?? null,
      );
      setNotice('Library loaded.');
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load your Spotify collections.',
      );
    } finally {
      setIsLoadingCollections(false);
    }
  }

  useEffect(() => {
    if (!session) {
      setCollections([]);
      setCollectionState(null);
      setRound(null);
      return;
    }

    void loadCollections();
    // Session changes should refresh library data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.accessToken]);

  useEffect(() => {
    if (!round || !webPlaybackDeviceId || !session) {
      return;
    }

    if (activePlayerTrackId && activePlayerTrackId !== round.track.id) {
      void withFreshSession((nextSession) =>
        pausePlayback(nextSession.accessToken, webPlaybackDeviceId),
      ).catch(() => {
        // Best-effort only.
      });
    }
    // Intentionally keyed to track changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.track.id]);

  useEffect(() => {
    if (!spotifyPlayerRef.current) {
      return;
    }

    void spotifyPlayerRef.current.setVolume(playerVolume / 100).catch(() => {
      setWebPlaybackStatus('Could not update the volume.');
    });
  }, [playerVolume]);

  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  );

  async function handleCollectionStart(collection: CollectionSummary) {
    if (!session) {
      return;
    }

    setError(null);
    setNotice('Loading songs...');
    setCollectionState(null);
    setRound(null);
    setScore(EMPTY_SCORE);
    recentTrackIdsRef.current = [];

    try {
      const nextCollection = await withFreshSession((nextSession) =>
        buildCollectionState(nextSession, collection),
      );

      const nextSummary =
        collection.kind === 'liked'
          ? { ...collection, trackCount: nextCollection.tracks.length }
          : collection;

      const hydratedCollection = {
        ...nextCollection,
        summary: nextSummary,
      } satisfies CollectionState;

      setCollections((current) =>
        current.map((item) =>
          item.id === hydratedCollection.summary.id ? hydratedCollection.summary : item,
        ),
      );
      setCollectionState(hydratedCollection);
      setNotice('Starting round...');
      setSelectedCollectionId(hydratedCollection.summary.id);
      await loadNextRound(hydratedCollection);
    } catch (loadError) {
      setCollectionState(null);
      setRound(null);
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load tracks for that collection.',
      );
    }
  }

  async function resolveOffListTrack(activeCollection: CollectionState) {
    for (let seedAttempt = 0; seedAttempt < 5; seedAttempt += 1) {
      const seedTrack = pickRandomTrack(activeCollection.tracks, recentTrackIdsRef.current);
      if (!seedTrack) {
        break;
      }

      const candidates = shuffle(
        await getLastFmRecommendations(envConfig.lastFmApiKey, seedTrack),
      ).slice(0, 12);

      for (const candidate of candidates) {
        const spotifyMatches = await withFreshSession((nextSession) =>
          searchSpotifyTracks(
            nextSession.accessToken,
            buildSpotifySearchQuery(candidate),
          ),
        );

        const match = spotifyMatches
          .map((item) => mapSpotifyTrack(item, 'lastfm'))
          .filter((track): track is GameTrack => Boolean(track))
          .find(
            (track) =>
              !activeCollection.trackIds.has(track.id) &&
              !activeCollection.trackKeys.has(buildTrackKey(track)) &&
              !recentTrackIdsRef.current.includes(track.id),
          );

        if (match) {
          return {
            track: match,
            sourceLabel: 'Last.fm wildcard',
            seedLabel: `${candidate.source} via ${seedTrack.artistNames[0]}`,
          };
        }
      }
    }

    return null;
  }

  async function loadNextRound(activeCollection = collectionState) {
    if (!activeCollection) {
      return;
    }

    if (!activeCollection.tracks.length) {
      setError('That collection has no playable Spotify tracks.');
      setRound(null);
      return;
    }

    if (!envConfig.lastFmApiKey) {
      setError('The site owner still needs to configure Last.fm for this deployment.');
      return;
    }

    setIsLoadingRound(true);
    setError(null);

    try {
      const wantsOnList = Math.random() < 0.5;

      if (wantsOnList) {
        const track = pickRandomTrack(activeCollection.tracks, recentTrackIdsRef.current);
        if (!track) {
          throw new Error('Could not pick a track from the selected collection.');
        }

        recentTrackIdsRef.current = appendRecentTrack(recentTrackIdsRef.current, track.id);
        setRound({
          track,
          isOnList: true,
          sourceLabel: 'Your collection',
          seedLabel: activeCollection.summary.name,
          revealed: false,
        });
        setNotice(null);
        return;
      }

      const recommendation = await resolveOffListTrack(activeCollection);
      if (recommendation) {
        recentTrackIdsRef.current = appendRecentTrack(
          recentTrackIdsRef.current,
          recommendation.track.id,
        );
        setRound({
          track: recommendation.track,
          isOnList: false,
          sourceLabel: recommendation.sourceLabel,
          seedLabel: recommendation.seedLabel,
          revealed: false,
        });
        setNotice(null);
        return;
      }

      const fallbackTrack = pickRandomTrack(activeCollection.tracks, recentTrackIdsRef.current);
      if (!fallbackTrack) {
        throw new Error('Could not build a fallback track for this round.');
      }

      recentTrackIdsRef.current = appendRecentTrack(
        recentTrackIdsRef.current,
        fallbackTrack.id,
      );
      setRound({
        track: fallbackTrack,
        isOnList: true,
        sourceLabel: 'Your collection',
        seedLabel: 'Fallback while Last.fm rerolled',
        revealed: false,
      });
      setNotice(null);
    } catch (roundError) {
      setError(
        roundError instanceof Error
          ? roundError.message
          : 'Could not prepare the next round.',
      );
    } finally {
      setIsLoadingRound(false);
    }
  }

  function handleGuess(guessOnList: boolean) {
    if (!round || round.revealed || isLoadingRound) {
      return;
    }

    const isCorrect = guessOnList === round.isOnList;
    const nextRound = {
      ...round,
      revealed: true,
      guessOnList,
      isCorrect,
    } satisfies GameRound;

    setRound(nextRound);
    setScore((current) => ({
      correct: current.correct + (isCorrect ? 1 : 0),
      incorrect: current.incorrect + (isCorrect ? 0 : 1),
      newFinds: current.newFinds + (isCorrect && !round.isOnList ? 1 : 0),
      added: current.added,
    }));

    if (round.isOnList) {
      window.setTimeout(() => {
        void loadNextRound();
      }, 900);
    }
  }

  async function handleAddTrack() {
    if (!collectionState || !round || round.isOnList || isAddingTrack) {
      return;
    }

    setIsAddingTrack(true);
    setError(null);

    try {
      await withFreshSession((nextSession) =>
        collectionState.summary.kind === 'liked'
          ? saveTrackToLibrary(nextSession.accessToken, round.track.id)
          : addTrackToPlaylist(
              nextSession.accessToken,
              collectionState.summary.id,
              round.track.spotifyUri,
            ),
      );

      const updatedTracks = dedupeTracks([...collectionState.tracks, round.track]);
      const updatedCollection = {
        ...collectionState,
        tracks: updatedTracks,
        trackIds: new Set(updatedTracks.map((track) => track.id)),
        trackKeys: new Set(updatedTracks.map((track) => buildTrackKey(track))),
        summary: {
          ...collectionState.summary,
          trackCount: updatedTracks.length,
        },
      } satisfies CollectionState;

      setCollectionState(updatedCollection);
      setCollections((current) =>
        current.map((item) =>
          item.id === updatedCollection.summary.id ? updatedCollection.summary : item,
        ),
      );
      setScore((current) => ({
        ...current,
        added: current.added + 1,
      }));
      setNotice('Song added.');
      await loadNextRound(updatedCollection);
    } catch (addError) {
      setError(
        addError instanceof Error
          ? addError.message
          : 'Could not add that track to the selected collection.',
      );
    } finally {
      setIsAddingTrack(false);
    }
  }

  function handleSignOut() {
    clearSpotifySession();
    spotifyPlayerRef.current?.disconnect();
    spotifyPlayerRef.current = null;
    setWebPlaybackDeviceId(null);
    setWebPlaybackState(null);
    setIsWebPlaybackReady(false);
    setWebPlaybackStatus(null);
    syncSession(null);
    setCollections([]);
    setCollectionState(null);
    setRound(null);
    setScore(EMPTY_SCORE);
    setNotice('Signed out of Spotify.');
  }

  const isConfigured = Boolean(envConfig.spotifyClientId && envConfig.lastFmApiKey);
  const activeRound = collectionState && round ? round : null;
  const activePlayerTrackId = webPlaybackState?.track_window.current_track.id ?? null;
  const isCurrentRoundPlaying = Boolean(
    activeRound &&
      activePlayerTrackId === activeRound.track.id &&
      webPlaybackState &&
      !webPlaybackState.paused,
  );
  const currentPlaybackPositionMs =
    activeRound && activePlayerTrackId === activeRound.track.id
      ? webPlaybackState?.position ?? 0
      : 0;
  const currentPlaybackDurationMs =
    activeRound && activePlayerTrackId === activeRound.track.id
      ? webPlaybackState?.duration ?? 0
      : 0;

  async function handlePlaybackToggle() {
    if (!activeRound || !webPlaybackDeviceId || !spotifyPlayerRef.current) {
      setWebPlaybackStatus('Browser player is still starting.');
      return;
    }

    setIsActivatingPlayback(true);
    setError(null);

    try {
      const nextSession = await withFreshSession(async (freshSession) => freshSession);
      await spotifyPlayerRef.current.activateElement();

      if (activePlayerTrackId === activeRound.track.id) {
        await spotifyPlayerRef.current.togglePlay();
      } else {
        await transferPlayback(nextSession.accessToken, webPlaybackDeviceId, false);
        await playTrackOnDevice(
          nextSession.accessToken,
          webPlaybackDeviceId,
          activeRound.track.spotifyUri,
        );
      }

      setWebPlaybackStatus(null);
    } catch (playbackError) {
      setWebPlaybackStatus(
        playbackError instanceof Error
          ? playbackError.message
          : 'Could not start browser playback.',
      );
    } finally {
      setIsActivatingPlayback(false);
    }
  }

  async function handleSeek(positionMs: number) {
    if (!spotifyPlayerRef.current || !currentPlaybackDurationMs) {
      return;
    }

    try {
      await spotifyPlayerRef.current.seek(positionMs);
    } catch {
      setWebPlaybackStatus('Could not seek this track.');
    }
  }

  return (
    <div className="app-shell">
      <div className="app-background" />
      <div className="app-content">
        <header className="hero-panel">
          <div className="brand-block">
            <p className="eyebrow">Spotify Playlist Detector</p>
            <h1>Find the songs you forgot you loved.</h1>
          </div>
        </header>

        <section className="status-strip" aria-label="Scoreboard">
          <div className="stat-card">
            <span>Correct</span>
            <strong>{score.correct}</strong>
          </div>
          <div className="stat-card">
            <span>Wrong</span>
            <strong>{score.incorrect}</strong>
          </div>
          <div className="stat-card">
            <span>Fresh finds</span>
            <strong>{score.newFinds}</strong>
          </div>
          <div className="stat-card">
            <span>Added</span>
            <strong>{score.added}</strong>
          </div>
        </section>

        <main className="main-grid">
          <aside className="sidebar-panel stack-gap">
            <section className="panel stack-gap">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Account</p>
                  <h2>Spotify</h2>
                </div>
                <span className={`state-pill ${isConfigured ? 'good' : 'warn'}`}>
                  {isConfigured ? 'Ready' : 'Setup needed'}
                </span>
              </div>

              <div className="auth-row">
                {session ? (
                  <>
                    <span className="auth-copy">
                      Signed in{profileName ? ` as ${profileName}` : ''}.
                    </span>
                    <button
                      className="button button-ghost"
                      type="button"
                      onClick={handleSignOut}
                    >
                      Sign out
                    </button>
                  </>
                ) : (
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={!isConfigured || isBooting || isSigningIn}
                    onClick={async () => {
                      setIsSigningIn(true);
                      try {
                        await beginSpotifyLogin(envConfig.spotifyClientId);
                      } finally {
                        setIsSigningIn(false);
                      }
                    }}
                  >
                    {isBooting ? 'Checking session...' : 'Sign in with Spotify'}
                  </button>
                )}
              </div>

              {!isConfigured ? (
                <p className="micro-copy">
                  This deployment still needs owner API configuration.
                </p>
              ) : null}
            </section>

            <section className="panel stack-gap">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Collection</p>
                  <h2>Pick a list</h2>
                </div>
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={!session || isLoadingCollections}
                  onClick={() => void loadCollections()}
                >
                  Refresh
                </button>
              </div>

              <div className="collection-list" role="list">
                {collections.length ? (
                  collections.map((collection) => {
                    const isActive = selectedCollectionId === collection.id;
                    const isLoaded = collectionState?.summary.id === collection.id;

                    return (
                      <button
                        key={collection.id}
                        type="button"
                        className={`collection-card ${isActive ? 'active' : ''}`}
                        onClick={() => setSelectedCollectionId(collection.id)}
                      >
                        <div className="collection-art">
                          {collection.imageUrl ? (
                            <img src={collection.imageUrl} alt="" />
                          ) : (
                            <div className="collection-placeholder">
                              {collection.kind === 'liked' ? 'LIKED' : 'PLAYLIST'}
                            </div>
                          )}
                        </div>
                        <div className="collection-meta">
                          <strong>{collection.name}</strong>
                          <span>{collection.trackCount} tracks</span>
                          <small>{collection.ownerName}</small>
                        </div>
                        {isLoaded ? <span className="state-pill good">Loaded</span> : null}
                      </button>
                    );
                  })
                ) : (
                  <p className="muted-copy">
                    {session
                      ? 'No collections loaded yet.'
                      : 'Sign in first, then your playlists will appear here.'}
                  </p>
                )}
              </div>

              <button
                className="button button-primary"
                type="button"
                disabled={!selectedCollection || isLoadingCollections || isLoadingRound}
                onClick={() =>
                  selectedCollection ? void handleCollectionStart(selectedCollection) : undefined
                }
              >
                {isLoadingCollections || isLoadingRound ? 'Loading...' : 'Play this list'}
              </button>
            </section>
          </aside>

          <section className="game-panel panel">
            {notice ? <div className="banner banner-info">{notice}</div> : null}
            {error ? <div className="banner banner-error">{error}</div> : null}

            {activeRound ? (
              <div className="game-stage">
                <div className="track-hero">
                  <div className="album-art-frame">
                    {activeRound.track.albumImageUrl ? (
                      <img
                        src={activeRound.track.albumImageUrl}
                        alt={`${activeRound.track.albumName} cover art`}
                      />
                    ) : (
                      <div className="album-art-fallback">NO ART</div>
                    )}
                  </div>

                  <div className="track-copy">
                    <p className="eyebrow">Now Playing</p>
                    <h2>{activeRound.track.name}</h2>
                    <p className="track-artist">{activeRound.track.artistLine}</p>
                    <p className="track-album">{activeRound.track.albumName}</p>
                  </div>
                </div>

                <div className="embed-shell custom-player-shell">
                  <div className="custom-player">
                    <div className="player-main">
                      <button
                        type="button"
                        className={`player-toggle ${isCurrentRoundPlaying ? 'playing' : ''}`}
                        onClick={() => void handlePlaybackToggle()}
                        disabled={!isWebPlaybackReady || isActivatingPlayback}
                        aria-label={isCurrentRoundPlaying ? 'Pause track' : 'Play track'}
                      >
                        <span className="player-toggle-icon">
                          {isCurrentRoundPlaying ? '❚❚' : '▶'}
                        </span>
                      </button>

                      <div className="player-copy">
                        <strong>{activeRound.track.name}</strong>
                        <span>{activeRound.track.artistLine}</span>
                      </div>

                      <a
                        className="player-open"
                        href={activeRound.track.spotifyUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                    </div>

                    <div className="player-progress">
                      <span>{formatDuration(currentPlaybackPositionMs)}</span>
                      <input
                        type="range"
                        min="0"
                        max={Math.max(currentPlaybackDurationMs, 1)}
                        value={Math.min(currentPlaybackPositionMs, currentPlaybackDurationMs || 0)}
                        onChange={(event) => void handleSeek(Number(event.target.value))}
                        disabled={!isWebPlaybackReady || currentPlaybackDurationMs <= 0}
                        aria-label="Track progress"
                      />
                      <span>{formatDuration(currentPlaybackDurationMs)}</span>
                    </div>

                    <div className="player-volume-row">
                      <span className="player-volume-label">Volume</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={playerVolume}
                        onChange={(event) => setPlayerVolume(Number(event.target.value))}
                        disabled={!isWebPlaybackReady}
                        aria-label="Player volume"
                      />
                      <span className="player-volume-value">{playerVolume}%</span>
                    </div>

                    <div className="player-status-row">
                      <span className={`player-status ${isWebPlaybackReady ? 'ready' : 'pending'}`}>
                        {isWebPlaybackReady ? 'Browser player ready' : 'Starting browser player'}
                      </span>
                      {webPlaybackStatus ? (
                        <span className="player-status-note">{webPlaybackStatus}</span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="answer-row">
                  <button
                    type="button"
                    className="guess-button guess-positive"
                    disabled={activeRound.revealed || isLoadingRound}
                    onClick={() => handleGuess(true)}
                  >
                    On My List!
                  </button>
                  <button
                    type="button"
                    className="guess-button guess-negative"
                    disabled={activeRound.revealed || isLoadingRound}
                    onClick={() => handleGuess(false)}
                  >
                    Not On My List
                  </button>
                </div>

                {activeRound.revealed ? (
                  <div className="reveal-panel">
                    <p className={`reveal-copy ${activeRound.isCorrect ? 'good' : 'bad'}`}>
                      {resultLabel(activeRound)}
                    </p>

                    {!activeRound.isOnList ? (
                      <div className="reveal-actions">
                        <a
                          className="button button-secondary"
                          href={activeRound.track.spotifyUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Spotify
                        </a>
                        <button
                          className="button button-primary"
                          type="button"
                          disabled={isAddingTrack}
                          onClick={() => void handleAddTrack()}
                        >
                          {isAddingTrack ? 'Adding...' : 'Add to my list'}
                        </button>
                        <button
                          className="button button-ghost"
                          type="button"
                          disabled={isLoadingRound}
                          onClick={() => void loadNextRound()}
                        >
                          Skip and next song
                        </button>
                      </div>
                    ) : (
                      <button
                        className="button button-ghost"
                        type="button"
                        disabled={isLoadingRound}
                        onClick={() => void loadNextRound()}
                      >
                        Next song now
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="hint-copy">Make the call.</p>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <p className="eyebrow">Ready When You Are</p>
                <h2>Pick a list and start.</h2>
              </div>
            )}
          </section>
        </main>

      </div>
    </div>
  );
}
