import { useContext } from "react";
import { PlayerContext, type PlayerContextValue } from "./playerContext";

export function useNowPlaying(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("useNowPlaying must be used inside a PlayerProvider");
  return ctx;
}
