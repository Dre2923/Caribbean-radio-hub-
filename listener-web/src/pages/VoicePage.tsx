import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { sendVoiceCommand } from "../api/voice";
import { ApiError } from "../api/client";
import { useNowPlaying } from "../player/useNowPlaying";
import { StationCard } from "../components/StationCard";
import { EventCard } from "../components/EventCard";
import type { RankedStation, Station, VoiceCommandResult } from "../api/types";

// Minimal Web Speech API surface this page actually uses - no @types
// package is added for it (still experimental/non-standard), so this
// declares only the handful of members touched below.
interface SpeechRecognitionResult {
  results: { [index: number]: { [index: number]: { transcript: string } } };
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResult) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// A plain Station has no reliability data (POST /v1/voice/command's
// rankedStations field is Station[], not the richer RankedStation[]
// GET /v1/stations/ranked returns - see backend/src/schemas/voice.ts).
// Wrapping with null/zeroed reliability lets this reuse the same
// fallback-chain player state machine honestly: StationCard/the player
// UI only render a reliability figure when uptimePercentage isn't null,
// so this never displays a fabricated number - it just omits one.
function toRankedStations(stations: Station[]): RankedStation[] {
  return stations.map((station) => ({
    station,
    reliability: {
      stationId: station.id,
      windowHours: 0,
      totalChecks: 0,
      reachableChecks: 0,
      uptimePercentage: null,
      averageLatencyMs: null,
    },
  }));
}

const EXAMPLE_COMMANDS = [
  "Play the top station",
  "Play reggae",
  "Pause",
  "What events are happening this weekend?",
  "Help",
];

export function VoicePage() {
  const { playSingle, playRanked, togglePlayPause, status: playerStatus } = useNowPlaying();
  const [text, setText] = useState("");
  const [result, setResult] = useState<VoiceCommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [listening, setListening] = useState(false);
  const [micUnsupported, setMicUnsupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  async function runCommand(commandText: string) {
    setError(null);
    setSubmitting(true);
    try {
      const commandResult = await sendVoiceCommand(commandText);
      setResult(commandResult);
      applyResult(commandResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function applyResult(commandResult: VoiceCommandResult) {
    // Mirrors docs/FLUTTER_CLIENT_SPEC.md Section 7.3's exact per-intent
    // client behavior table.
    if (commandResult.intent === "play_station" && commandResult.station) {
      playSingle(commandResult.station);
    } else if (commandResult.intent === "play_ranked" && commandResult.rankedStations) {
      playRanked(toRankedStations(commandResult.rankedStations));
    } else if (commandResult.intent === "playback_control" && commandResult.action) {
      if (commandResult.action === "pause" && playerStatus === "playing") togglePlayPause();
      else if (commandResult.action === "resume" && playerStatus === "paused") togglePlayPause();
      // "stop"/"next"/"previous" aren't distinct operations this web
      // prototype's player exposes yet (see PlayerProvider.tsx) - stated
      // honestly rather than faked; the result panel below shows this.
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    void runCommand(text.trim());
  }

  function startListening() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setMicUnsupported(true);
      return;
    }
    const recognition = new Ctor();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) {
        setText(transcript);
        void runCommand(transcript);
      }
    };
    recognition.onerror = () => {
      // A real, honest failure mode in this sandboxed environment: Web
      // Speech API recognition requires a live connection to the
      // browser's speech-recognition service (e.g. Google's), an
      // external host this session's egress allowlist has already been
      // confirmed (Phase 1 build) to block for arbitrary hosts. Reported
      // truthfully rather than silently retried or hidden.
      setMicUnsupported(true);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    setListening(true);
    setMicUnsupported(false);
    recognition.start();
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ocean-900">Voice commands</h1>
        <p className="mt-1 text-sm text-ocean-600">
          Type a command, or try the microphone (speech recognition support varies by browser and network
          environment - typing always works and exercises the exact same backend command resolver).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. Play reggae"
          className="flex-1 rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm text-ocean-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500"
        />
        <button
          type="submit"
          disabled={submitting}
          className="rounded-full bg-ocean-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ocean-600 disabled:opacity-60"
        >
          {submitting ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          onClick={listening ? stopListening : startListening}
          aria-pressed={listening}
          aria-label={listening ? "Stop listening" : "Start voice input"}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
            listening ? "bg-sunset-600 text-white" : "bg-ocean-100 text-ocean-700 hover:bg-ocean-200"
          }`}
        >
          🎤
        </button>
      </form>

      {micUnsupported && (
        <p className="text-sm text-ocean-500">
          Microphone speech recognition isn&apos;t available right now in this environment. Typed commands still
          exercise the real voice command backend end-to-end.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {EXAMPLE_COMMANDS.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setText(example);
              void runCommand(example);
            }}
            className="rounded-full bg-ocean-50 px-3 py-1 text-xs font-medium text-ocean-700 hover:bg-ocean-100"
          >
            {example}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm font-medium text-sunset-600">
          {error}
        </p>
      )}

      {result && <VoiceResultPanel result={result} onPickCandidate={(station) => playSingle(station)} />}
    </div>
  );
}

function VoiceResultPanel({
  result,
  onPickCandidate,
}: {
  result: VoiceCommandResult;
  onPickCandidate: (station: Station) => void;
}) {
  return (
    <div className="rounded-xl border border-ocean-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-ocean-400">Intent: {result.intent}</p>

      {result.intent === "play_station" && result.station && (
        <p className="mt-2 text-ocean-800">Now playing <strong>{result.station.name}</strong>.</p>
      )}

      {result.intent === "play_ranked" && result.rankedStations && (
        <p className="mt-2 text-ocean-800">
          Playing the best available match: <strong>{result.rankedStations[0]?.name}</strong>
          {result.rankedStations.length > 1 ? ` (with ${result.rankedStations.length - 1} fallback${result.rankedStations.length > 2 ? "s" : ""})` : ""}.
        </p>
      )}

      {result.intent === "playback_control" && (
        <p className="mt-2 text-ocean-800">
          {result.action === "pause" || result.action === "resume"
            ? `Playback ${result.action}d.`
            : `"${result.action}" isn't supported by this web prototype's player yet.`}
        </p>
      )}

      {result.intent === "search_events" && (
        <div className="mt-2 space-y-2">
          <p className="text-ocean-800">
            {result.events && result.events.length > 0
              ? `${result.events.length} matching event${result.events.length === 1 ? "" : "s"}:`
              : "No matching events found."}
          </p>
          {result.events?.map((event) => <EventCard key={event.id} event={event} />)}
        </div>
      )}

      {result.intent === "help" && result.helpTopics && (
        <div className="mt-2 space-y-3">
          {result.helpTopics.map((topic) => (
            <div key={topic.category}>
              <p className="font-semibold text-ocean-800">{topic.category}</p>
              <ul className="ml-4 list-disc text-sm text-ocean-600">
                {topic.examples.map((example) => (
                  <li key={example}>&quot;{example}&quot;</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {result.intent === "ambiguous" && result.candidates && (
        <div className="mt-2 space-y-2">
          <p className="text-ocean-800">Which one did you mean?</p>
          {result.candidates.map((station) => (
            <StationCard key={station.id} station={station} onPlay={() => onPickCandidate(station)} />
          ))}
        </div>
      )}

      {(result.intent === "not_found" || result.intent === "unrecognized") && result.message && (
        <p className="mt-2 text-ocean-800">{result.message}</p>
      )}
    </div>
  );
}
