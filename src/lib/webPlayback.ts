let sdkPromise: Promise<void> | null = null;

function loadSpotifySdkScript() {
  return new Promise<void>((resolve, reject) => {
    if ((window as Window & { Spotify?: unknown }).Spotify) {
      resolve();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-spotify-web-playback-sdk="true"]',
    );

    if (existingScript) {
      const previousReady = window.onSpotifyWebPlaybackSDKReady;
      window.onSpotifyWebPlaybackSDKReady = () => {
        previousReady?.();
        resolve();
      };
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.dataset.spotifyWebPlaybackSdk = 'true';
    script.onerror = () => reject(new Error('Spotify Web Playback SDK failed to load.'));

    const previousReady = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      previousReady?.();
      resolve();
    };

    document.body.appendChild(script);
  });
}

export function ensureSpotifyWebPlaybackSdk() {
  if (!sdkPromise) {
    sdkPromise = loadSpotifySdkScript();
  }

  return sdkPromise;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: SpotifyNamespace;
  }
}

export interface SpotifyWebPlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: {
      id: string;
      name: string;
      artists: Array<{ name: string }>;
    };
  };
}

export interface SpotifyPlayerInstance {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(
    event:
      | 'ready'
      | 'not_ready'
      | 'initialization_error'
      | 'authentication_error'
      | 'account_error'
      | 'autoplay_failed'
      | 'player_state_changed',
    cb: (payload: unknown) => void,
  ): boolean;
  removeListener(event?: string): boolean;
  activateElement(): Promise<void>;
  togglePlay(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
}

interface SpotifyPlayerOptions {
  name: string;
  volume?: number;
  getOAuthToken: (cb: (token: string) => void) => void;
}

interface SpotifyNamespace {
  Player: new (options: SpotifyPlayerOptions) => SpotifyPlayerInstance;
}
