import { createContext } from "react";
import type { RankedStation, Station } from "../api/types";

export type PlayerSource =
  | { kind: "ranked"; stations: RankedStation[]; index: number }
  | { kind: "single"; station: Station };

export type PlayerStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "switching"
  | "error"
  | "offline-blocked"
  | "exhausted";

export interface PlayerState {
  source: PlayerSource | null;
  status: PlayerStatus;
  message: string | null;
}

export interface PlayerContextValue extends PlayerState {
  currentStation: Station | null;
  playRanked: (stations: RankedStation[]) => void;
  playSingle: (station: Station) => void;
  togglePlayPause: () => void;
  retry: () => void;
}

// Split into its own non-component module (mirroring
// admin-dashboard/src/auth/authContext.ts's own reasoning exactly) so
// PlayerProvider.tsx and useNowPlaying.ts can each export exactly one
// thing Vite's Fast Refresh can hot-reload as a unit -
// react-refresh/only-export-components flags a file mixing a component
// export with a non-component one, which this three-way split avoids
// entirely instead of silencing the warning.
export const PlayerContext = createContext<PlayerContextValue | null>(null);
