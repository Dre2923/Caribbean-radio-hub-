import { apiFetch } from "./client";
import type { VoiceCommandResult } from "./types";

// POST /v1/voice/command - see docs/FLUTTER_CLIENT_SPEC.md Section 7.
// The client performs speech-to-text (or here, typed text) and sends
// only the resulting text; the backend never receives audio.
export function sendVoiceCommand(text: string): Promise<VoiceCommandResult> {
  return apiFetch("/v1/voice/command", { method: "POST", body: { text } });
}
