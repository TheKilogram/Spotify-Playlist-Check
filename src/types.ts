export interface AppConfig {
  spotifyClientId: string;
  lastFmApiKey: string;
}

export interface CollectionSummary {
  id: string;
  kind: 'liked' | 'playlist';
  name: string;
  description: string;
  imageUrl: string | null;
  ownerName: string;
  trackCount: number;
}

export interface GameTrack {
  id: string;
  name: string;
  artistNames: string[];
  artistLine: string;
  albumName: string;
  albumImageUrl: string | null;
  spotifyUri: string;
  spotifyUrl: string;
  source: 'playlist' | 'lastfm';
}

export interface CollectionState {
  summary: CollectionSummary;
  tracks: GameTrack[];
  trackIds: Set<string>;
}

export interface GameRound {
  track: GameTrack;
  isOnList: boolean;
  sourceLabel: string;
  seedLabel: string;
  revealed: boolean;
  guessOnList?: boolean;
  isCorrect?: boolean;
}

export interface ScoreBoard {
  correct: number;
  incorrect: number;
  newFinds: number;
  added: number;
}

export interface LastFmCandidate {
  artist: string;
  track: string;
  source: string;
}
