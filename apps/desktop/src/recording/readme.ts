// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecordingTranscript } from "@j3-bots/desktop-bridge";
import type { RecordedScreen } from "./screens.ts";

// The two files that explain a recording to whoever opens its zip, a bot's
// AI first: `manifest.json`, what was recorded and how, and `README.md`,
// how to read the rest; and `transcript.json`, what the operator said, when
// it was written down. Written in English, as the files' own names are.

export interface RecordingFacts {
  readonly appVersion: string;
  readonly os: { readonly platform: string; readonly release: string };
  /** ISO 8601, UTC. */
  readonly startedAt: string;
  /** IANA, such as `America/Sao_Paulo`; null when the system did not say. */
  readonly timeZone: string | null;
  /** Recorded time, paused time left out. */
  readonly durationMs: number;
  /** The app stopped before the operator did; the zip holds what was written. */
  readonly interrupted: boolean;
  readonly input: "everything" | "screen-and-voice";
  readonly passwords: "hidden" | "pause";
  readonly screens: ReadonlyArray<RecordedScreen>;
  readonly voice: boolean;
  /** Whether `transcript.json` is in the zip. */
  readonly transcript: boolean;
  readonly frames: number;
}

export const screenFile = (screen: number) => `screen-${screen}.mp4`;
export const VOICE_FILE = "voice.webm";
export const EVENTS_FILE = "events.jsonl";
export const TRANSCRIPT_FILE = "transcript.json";
export const MANIFEST_FILE = "manifest.json";
export const README_FILE = "README.md";

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** `transcript.json`'s text. */
export const transcriptText = (transcript: RecordingTranscript) =>
  `${JSON.stringify(
    {
      format: "j3-bots-screen-recording-transcript",
      version: 1,
      segments: transcript.segments.map((segment) =>
        segment.words === null
          ? { t: segment.t, until: segment.until, text: segment.text }
          : segment,
      ),
    },
    null,
    2,
  )}\n`;

/** `manifest.json`'s text. */
export const manifestText = (facts: RecordingFacts) =>
  `${JSON.stringify(manifestOf(facts), null, 2)}\n`;

const manifestOf = (facts: RecordingFacts) => ({
  format: "j3-bots-screen-recording",
  version: 1,
  app: { name: "J3 Bots", version: facts.appVersion },
  os: facts.os,
  startedAt: facts.startedAt,
  timeZone: facts.timeZone,
  durationMs: Math.round(facts.durationMs),
  interrupted: facts.interrupted,
  input: facts.input,
  passwords: facts.passwords,
  screens: facts.screens.map((screen) => ({
    screen: screen.screen,
    file: screenFile(screen.screen),
    desktop: screen.bounds,
    video: screen.video,
    scale: round(screen.video.width / screen.bounds.width),
  })),
  voice: facts.voice ? { file: VOICE_FILE, codec: "opus" } : null,
  transcript: facts.transcript ? TRANSCRIPT_FILE : null,
  events: EVENTS_FILE,
  frames: facts.frames,
});

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours} h ${minutes} min`
    : minutes > 0
      ? `${minutes} min ${rest} s`
      : `${rest} s`;
};

const TRANSCRIPT_SECTION = `## Transcript

\`${TRANSCRIPT_FILE}\` holds \`segments\`, in order, each what was said from \`t\` to \`until\` (the same clock as the events), at most 30 seconds long and cut where the voice was quietest. Stretches where nothing was said are left out. A segment's \`words\` each have a \`t\`: when the speech recognizer had heard that word, so it was said up to about a second before; a word it settled only at the segment's end has the segment's \`until\`. A segment without \`words\` was written down by a recognizer that gives only the text, so its time is the segment's. Speech recognition gets some words wrong, names most of all: when a word matters, listen to the voice at that time.

`;

export const readmeOf = (facts: RecordingFacts): string => {
  const screens = facts.screens
    .map(
      (screen) =>
        `- \`${screenFile(screen.screen)}\`: screen ${screen.screen}, ${screen.bounds.width}×${screen.bounds.height} on the desktop, recorded at ${screen.video.width}×${screen.video.height}.`,
    )
    .join("\n");
  const voice = facts.voice
    ? facts.transcript
      ? `- \`${VOICE_FILE}\`: the operator's voice (Opus).\n- \`${TRANSCRIPT_FILE}\`: what they said, written down by speech recognition, with times (below).`
      : `- \`${VOICE_FILE}\`: the operator's voice (Opus). There is no transcript: listen to it, or transcribe it with a tool you have.`
    : "- No voice was recorded.";
  const input =
    facts.input === "everything"
      ? `- \`${EVENTS_FILE}\`: one JSON event per line: clicks, typed text, keys and shortcuts, scrolls, the window in front, pauses.`
      : `- \`${EVENTS_FILE}\`: J3 Bots could not read keys and clicks on this computer (Linux on Wayland lets no app read them; macOS only once the operator allows J3 Bots under Accessibility), so it holds no clicks, typed text, keys or scrolls: only the window in front, where this system says it, pauses and the stop. Follow the video.`;
  const passwords =
    facts.passwords === "hidden"
      ? "When the system said a password was being typed, or could not say, no character is kept."
      : "This system does not say when a password is typed; the operator was asked to pause before typing one.";
  return `# Screen recording

The operator of J3 Bots recorded their screen to show you how they do something, talking as they went, as they would to a new teammate. Watch it, listen to it, and use what you learn: ask them about anything unclear, and decide what to do with it.

Recorded with J3 Bots ${facts.appVersion} on ${facts.os.platform}, starting ${facts.startedAt}${facts.timeZone === null ? "" : ` (time zone ${facts.timeZone})`}, for ${duration(facts.durationMs)}.${facts.interrupted ? "\n\nThe recording was interrupted (the app stopped before the operator did): it holds what was written until then." : ""}

## Files

${screens}
${voice}
${input}
- \`frames/\`: a small JPEG of the screen at each click and each change of window (${facts.frames} in all), named by time and screen, so you can follow what happened without a video tool. An event's \`frame\` may be missing when the screen could not be read just then, or the recording was paused by the time it was taken.
- \`${MANIFEST_FILE}\`: the same facts as data: screens, sizes, scale, start time, time zone, system, version.

## Time

Every time is milliseconds since the recording started, with paused time left out: the videos' and the voice's own clock. An event at \`t\` shows in each video at second \`t / 1000\`. A \`pause\` and the \`resume\` after it share their \`t\`: whatever happened in between was hidden on purpose and is in no file.

${facts.transcript ? TRANSCRIPT_SECTION : ""}## Events

- \`click\`: \`button\`, \`clicks\` (2 for a double click), \`screen\`, \`x\` and \`y\` in that screen's video pixels, \`nx\` and \`ny\` from 0 to 1 across the screen, and \`frame\`, the picture taken then.
- \`text\`: characters typed together, from \`t\` to \`until\`, with Backspace already applied. They are read from the keys pressed as on a US keyboard: letters, digits and spaces are right, punctuation may differ on other layouts. The video shows what was really typed.
- \`password\`: something was typed into a password, from \`t\` to \`until\`. ${passwords}
- \`key\`: a key such as \`Enter\`, \`Tab\` or \`ArrowDown\`. \`shortcut\`: keys pressed together, such as \`Ctrl+C\`.
- \`scroll\`: \`direction\`, \`steps\` (wheel notches, as the system reported them), where it began.
- \`window\`: the app and window title in front, when it changed, with a \`frame\`.
- \`start\`, \`pause\`, \`resume\`, \`stop\`.

## Useful commands

\`\`\`sh
# What is in a video
ffprobe -hide_banner screen-1.mp4
# The screen at an event at t = 83250 ms
ffmpeg -ss 83.25 -i screen-1.mp4 -frames:v 1 at-83250.jpg
# One picture every 10 seconds
ffmpeg -i screen-1.mp4 -vf fps=1/10 every-10s-%04d.jpg
# The voice as 16 kHz WAV, for a speech-to-text tool
ffmpeg -i ${VOICE_FILE} -ar 16000 -ac 1 voice.wav
\`\`\`

A point \`(x, y)\` of screen \`n\` in desktop coordinates is at \`((x - desktop.x) × scale, (y - desktop.y) × scale)\` in \`screen-n.mp4\`, with \`desktop\` and \`scale\` from \`${MANIFEST_FILE}\`. The recording's own floating control may show in the video on Linux, where the system cannot leave it out.
`;
};
