"use client"
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  Info,
  X,
  Plus,
  Minus,
  Crosshair,
  Hash,
  Infinity as InfinityIcon,
  Eraser,
  Repeat,
  Palette,
  Volume2,
  VolumeX,
} from "lucide-react";

// --- Grid & visual constants ---------------------------------------------
const DEFAULT_GRID = 3;
const MIN_GRID = 1;
const MAX_GRID = 801;
const MIN_SCALE = 1;
const MAX_SCALE = 400;             // raised so tiny grids can zoom in
const COUNT_MIN_SCALE = 22;
const LONG_PRESS_MS = 500;
const TAP_MOVEMENT_PX = 6;
const FIT_PADDING = 0.88;          // leave ~12% breathing room around the grid
// Cycle detection is automatic up to this grid size. On larger grids the
// state space is astronomical and detection would be both useless and
// expensive. 48² = 2304 cells — still fast to hash at high step rates.
const MAX_CYCLE_GRID = 48;

const COLOR_BG = "#f5f1e8";        // warm cream — palette index 0
const COLOR_INK = "#1a1714";       // warm near-black — UI chrome only
const COLOR_ANT_REGULAR = "#e94b3c";
const COLOR_ANT_INVERSE = "#0f7a82";
const COLOR_TEXT = "#f5ebd7";
const COLOR_COUNT_ON_LIGHT = "rgba(26, 23, 20, 0.42)";
const COLOR_COUNT_ON_DARK = "rgba(245, 241, 232, 0.38)";

// --- Multi-color palette -------------------------------------------------
// 12 cells of color, indexed 0..11. Cells store this index as a Uint8 byte.
// Index 0 is the cream "background" / empty state; the rest form a muted
// rainbow chosen to (a) feel editorial, (b) stay distinct from the bright
// vermillion / teal ant body colors so ants always stand out.
const NUM_COLORS = 12;
const PALETTE: readonly string[] = [
  "#f5f1e8", // 0 — cream (background)
  "#ead08a", // 1 — wheat
  "#d49d4a", // 2 — amber
  "#bd6b32", // 3 — orange-brown
  "#9a3f3a", // 4 — clay red
  "#702c52", // 5 — wine
  "#4a2e6b", // 6 — purple
  "#293a78", // 7 — deep blue
  "#1d5c7e", // 8 — petrol blue
  "#15725c", // 9 — green-teal
  "#3e7a3a", // 10 — emerald
  "#5e6629", // 11 — moss
];
// For each color, whether visit-count text should be light (true) or dark
// (false). Derived from a quick perceptual-lightness threshold; baked in
// as a constant so we don't recompute every frame.
const PALETTE_TEXT_LIGHT: readonly boolean[] = [
  false, false, false, true, true, true, true, true, true, true, true, true,
];

// --- Color → musical note mapping ----------------------------------------
// Each color has a MIDI note number (60 = middle C). The default is the
// chromatic scale C4 → B4, where each color is one semitone above the
// previous. Notes are editable per-row in the rules panel, so what's
// stored at runtime is a 12-element array of MIDI numbers; name and
// frequency are derived on the fly via the helpers below.
const NOTE_LETTERS: readonly string[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
const MIN_MIDI = 24; // C1 — anything lower drops into sub-audible rumble
const MAX_MIDI = 96; // C7 — high enough; above gets piercing
const DEFAULT_NOTES: readonly number[] = [
  60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71,
];

function midiToName(midi: number): string {
  const letter = NOTE_LETTERS[((midi % 12) + 12) % 12];
  // MIDI 60 is C4 by the most common convention (Yamaha / Sound Blaster
  // standard). Some sources call this C3; we'll stick with C4 here.
  const octave = Math.floor(midi / 12) - 1;
  return `${letter}${octave}`;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clampMidi(m: number): number {
  if (!Number.isFinite(m)) return 60;
  return Math.max(MIN_MIDI, Math.min(MAX_MIDI, Math.round(m)));
}

// --- Color transitions ---------------------------------------------------
// For each source color, what color a cell becomes after an ant leaves.
// Default is the cyclic shift (color N → color N+1, with 11 wrapping to 0),
// which gives the classical multi-color Langton's ant behavior. Editable
// in the rules panel — users can build any directed graph on the colors.
const DEFAULT_TRANSITIONS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0,
];

// --- Transition rules ----------------------------------------------------
// One rule per color. Each rule says how the ant turns when it's on a cell
// of that color. The cell color always advances to (c + 1) mod NUM_COLORS
// after the ant leaves.
//   L = turn left 90°    R = turn right 90°
//   N = no turn          U = u-turn (180°)
// The default rule produces visible structure quickly without becoming a
// boring highway in two steps.
const DEFAULT_RULES = "RRLRLRLLLRRR";

const RULE_PRESETS: { name: string; rules: string }[] = [
  { name: "default", rules: "RRLRLRLLLRRR" },
  { name: "alternate", rules: "RLRLRLRLRLRL" },
  { name: "blocks", rules: "RRLLRRLLRRLL" },
  { name: "highway", rules: "LRRRRRLLRRRR" },
];

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
// Speed scale: per-frame fractional step count at 60 fps. Each tick the
// loop adds `SPEEDS[speedIdx]` to an accumulator; whole-number crossings
// fire a sim step. This range is intentionally slow enough across the
// board that every step is audible as a distinct note: the slowest is one
// step every two seconds, the fastest is rapid but still discernible. The
// progression is roughly geometric (×4) so the slider feels even.
const SPEEDS = [0.5 / 60, 2 / 60, 8 / 60, 0.5, 2, 10];
const SPEED_LABELS = ["½/s", "2/s", "8/s", "30/s", "120/s", "600/s"];

// --- Types ---------------------------------------------------------------
type AntType = "regular" | "inverse";
type Ant = { id: number; x: number; y: number; dir: number; type: AntType };
type Point = { x: number; y: number };

type TurnAction = "L" | "R" | "N" | "U";
const TURN_ACTIONS: readonly TurnAction[] = ["L", "R", "N", "U"];

// Parse a rule string into exactly NUM_COLORS turn actions. Unknown chars
// become 'R', the string is padded with 'R' if short and truncated if long.
function parseRules(s: string): TurnAction[] {
  const out: TurnAction[] = [];
  const up = s.toUpperCase();
  for (let i = 0; i < NUM_COLORS; i++) {
    const c = up[i];
    if (c === "L" || c === "R" || c === "N" || c === "U") {
      out.push(c);
    } else {
      out.push("R");
    }
  }
  return out;
}

function rulesToString(r: readonly TurnAction[]): string {
  return r.join("");
}

// --- Audio synthesis -----------------------------------------------------
// Plays a soft chime per color change. The AudioContext is created lazily
// (browsers won't let us produce sound before a user gesture) and per-pitch
// debouncing keeps things sane at higher step rates.
class NoteSynth {
  private ctx: AudioContext | null = null;
  private destination: AudioNode | null = null;
  private lastPlayTime: number[] = new Array(NUM_COLORS).fill(-Infinity);
  // Per-color frequency in Hz. Set externally by the component whenever
  // the user edits the note mapping. Initialized to the default chromatic
  // C4→B4 spread so play() works even before the first React effect runs.
  private noteFrequencies: number[] = DEFAULT_NOTES.map(midiToFreq);
  enabled = true;
  // Minimum gap (in seconds) between two plays of the same pitch. At 45ms,
  // a single color note tops out around 22 plays/sec, which keeps even the
  // fastest speed sounding musical rather than mashed.
  private static MIN_PITCH_INTERVAL = 0.045;

  setNoteFrequencies(freqs: number[]): void {
    // Defensive copy so the synth doesn't share its array with React state.
    this.noteFrequencies = freqs.slice(0, NUM_COLORS);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      type AnyAC = typeof AudioContext;
      const W = window as unknown as {
        AudioContext?: AnyAC;
        webkitAudioContext?: AnyAC;
      };
      const AC = W.AudioContext ?? W.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      // Compressor → destination. The compressor tames peaks when many
      // notes overlap, so we can keep per-note gain moderate without
      // worrying about clipping on dense flips.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 8;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      comp.connect(this.ctx.destination);
      this.destination = comp;
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  // Call after a user gesture (e.g. clicking Play) so the context can
  // actually produce sound. No-op if already running or unavailable.
  resume(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {
        /* user hasn't gestured yet, ignore */
      });
    }
  }

  play(colorIdx: number): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.destination) return;
    // Bail early before scheduling anything if the context isn't actually
    // running — saves work and avoids the "ghost note" effect where we
    // queue sound that never plays.
    if (ctx.state !== "running") return;

    const now = ctx.currentTime;
    if (now - this.lastPlayTime[colorIdx] < NoteSynth.MIN_PITCH_INTERVAL) {
      return;
    }
    this.lastPlayTime[colorIdx] = now;

    const freq = this.noteFrequencies[colorIdx];
    if (!freq || freq <= 0) return;

    // Triangle wave: more harmonic content than a sine but still soft.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;

    // ADSR-like envelope: very short attack, exponential decay to silence.
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.28, now + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.36);

    osc.connect(env);
    env.connect(this.destination);
    osc.start(now);
    osc.stop(now + 0.38);
  }

  dispose(): void {
    if (this.ctx) {
      this.ctx.close().catch(() => {
        /* nothing to do */
      });
      this.ctx = null;
      this.destination = null;
    }
  }
}

type TapState = {
  type: "tap";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  antId: number | null;
  longPressTimer: number | null;
  consumed: boolean;
};
type DragState =
  | TapState
  | { type: "pan"; lastX: number; lastY: number }
  | { type: "dragAnt"; antId: number }
  | {
      type: "pinch";
      startDist: number;
      startScale: number;
      cx: number;
      cy: number;
      startOffset: Point;
    };

function makeInitialAnts(n: number): Ant[] {
  const c = Math.floor(n / 2);
  return [{ id: 1, x: c, y: c, dir: 0, type: "regular" }];
}

function clampGrid(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_GRID;
  return Math.max(MIN_GRID, Math.min(MAX_GRID, Math.floor(n)));
}

// A frozen snapshot of everything Reset needs to rewind: the board, the
// ants (positions, directions, types), the id counter, and the black count.
// Counts (visit counts) are intentionally NOT snapshotted — they represent
// the history of the run and should return to zero on reset.
type InitialState = {
  cells: Uint8Array;
  ants: Ant[];
  nextAntId: number;
  paintedCount: number;
};

// Cycle detection: once the full state (cells + all ants' positions,
// directions, types) matches a state we've seen before, the simulation
// will loop forever. `firstSeenAtStep` is the earliest step with this
// state; `detectedAtStep` is when we noticed; `length` is the period.
type CycleInfo = {
  length: number;
  firstSeenAtStep: number;
  detectedAtStep: number;
};

// Hash the full simulation state into a 64-bit composite key (two
// independent 32-bit FNV-1a passes, combined as a string). False-positive
// rate is ~1/2^64 — effectively zero over any realistic run.
//
// Ants are sorted canonically before hashing: ant *identity* doesn't
// affect dynamics, only the multiset of (type, x, y, dir) does.
function hashState(cells: Uint8Array, ants: Ant[]): string {
  let h1 = 2166136261; // FNV-1a offset basis
  let h2 = 3141592653; // different seed for the second pass

  // Pass over cells.
  const len = cells.length;
  for (let i = 0; i < len; i++) {
    const b = cells[i];
    h1 = Math.imul(h1 ^ b, 16777619);
    h2 = Math.imul(h2 ^ (b + 127), 2654435761);
  }

  // Sort ants for canonical order.
  const sorted = ants.slice().sort((a, b) => {
    const ta = a.type === "regular" ? 0 : 1;
    const tb = b.type === "regular" ? 0 : 1;
    if (ta !== tb) return ta - tb;
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return a.dir - b.dir;
  });

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    // Pack (x, y, dir, type) into one 32-bit word — x and y are < 2^10
    // since MAX_CYCLE_GRID ≤ 48, which fits with room to spare.
    const packed =
      (a.x & 0x3ff) |
      ((a.y & 0x3ff) << 10) |
      ((a.dir & 0x3) << 20) |
      ((a.type === "regular" ? 0 : 1) << 22);
    h1 = Math.imul(h1 ^ (packed & 0xff), 16777619);
    h1 = Math.imul(h1 ^ ((packed >>> 8) & 0xff), 16777619);
    h1 = Math.imul(h1 ^ ((packed >>> 16) & 0xff), 16777619);
    h1 = Math.imul(h1 ^ ((packed >>> 24) & 0xff), 16777619);
    h2 = Math.imul(h2 ^ packed, 2654435761);
  }

  return `${h1 >>> 0}_${h2 >>> 0}`;
}

// -------------------------------------------------------------------------

export default function LangtonsAntApp() {
  // Canvas
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);

  // Simulation state — these refs get rebuilt when grid size changes.
  const gridSizeRef = useRef<number>(DEFAULT_GRID);
  const cellsRef = useRef<Uint8Array>(
    new Uint8Array(DEFAULT_GRID * DEFAULT_GRID)
  );
  const countsRef = useRef<Uint32Array>(
    new Uint32Array(DEFAULT_GRID * DEFAULT_GRID)
  );
  const antsRef = useRef<Ant[]>(makeInitialAnts(DEFAULT_GRID));
  const nextAntIdRef = useRef<number>(2);
  const stepCountRef = useRef<number>(0);
  const paintedCountRef = useRef<number>(0);

  // Snapshot captured right before the first sim step; Reset rewinds here.
  // Cleared on Clear and on grid-size change.
  const initialStateRef = useRef<InitialState | null>(null);

  // Cycle detection state. `stateHashesRef` maps state-hash → step number;
  // it's populated as the simulation runs. `cycleInfoRef` is null until a
  // cycle is detected, then stays set (badge persists) until clear/reset/
  // resize/torus-change.
  const stateHashesRef = useRef<Map<string, number>>(new Map());
  const cycleInfoRef = useRef<CycleInfo | null>(null);

  // View
  const scaleRef = useRef<number>(1);
  const offsetRef = useRef<Point>({ x: 0, y: 0 });

  // Loop
  const runningRef = useRef<boolean>(false);
  const speedRef = useRef<number>(2);
  const stepAccumulatorRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  // Option refs
  const showCountsRef = useRef<boolean>(false);
  const torusRef = useRef<boolean>(true);
  const rulesRef = useRef<TurnAction[]>(parseRules(DEFAULT_RULES));
  const transitionsRef = useRef<number[]>(DEFAULT_TRANSITIONS.slice());

  // Audio synth — lazily creates an AudioContext on first user gesture.
  // Created once per component instance; disposed on unmount.
  const synthRef = useRef<NoteSynth | null>(null);
  if (synthRef.current === null) synthRef.current = new NoteSynth();

  // Gestures
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const dragStateRef = useRef<DragState | null>(null);

  // UI state
  const [gridSize, setGridSize] = useState<number>(DEFAULT_GRID);
  const [sizeDraft, setSizeDraft] = useState<string>(String(DEFAULT_GRID));
  const [running, setRunning] = useState<boolean>(false);
  const [stepCount, setStepCount] = useState<number>(0);
  const [paintedCount, setPaintedCount] = useState<number>(0);
  const [speedIdx, setSpeedIdx] = useState<number>(1);
  const [scaleDisplay, setScaleDisplay] = useState<number>(1);
  const [showInfo, setShowInfo] = useState<boolean>(true);
  const [hasStarted, setHasStarted] = useState<boolean>(false);
  const [showCounts, setShowCounts] = useState<boolean>(false);
  const [torus, setTorus] = useState<boolean>(true);
  const [soundOn, setSoundOn] = useState<boolean>(true);
  const [rules, setRules] = useState<TurnAction[]>(() =>
    parseRules(DEFAULT_RULES)
  );
  const [rulesDraft, setRulesDraft] = useState<string>(DEFAULT_RULES);
  const [showRules, setShowRules] = useState<boolean>(false);
  // MIDI numbers per color (12 entries). Editable in the rules panel.
  // Default is the chromatic C4→B4 spread.
  const [notes, setNotes] = useState<number[]>(() => DEFAULT_NOTES.slice());
  // Per-source-color destination after a transition fires. Default is the
  // cyclic shift, identical to the classic multi-color Langton's ant.
  const [transitions, setTransitions] = useState<number[]>(() =>
    DEFAULT_TRANSITIONS.slice()
  );
  const [antVersion, setAntVersion] = useState<number>(0);
  // Mirrors initialStateRef !== null. Used to disable Reset when there's
  // nothing to rewind to.
  const [hasSnapshot, setHasSnapshot] = useState<boolean>(false);
  // Mirrors cycleInfoRef — only set once detection fires, then persists.
  const [cycleInfo, setCycleInfo] = useState<CycleInfo | null>(null);

  // Keep draft in sync when gridSize is bumped via − + buttons.
  useEffect(() => {
    setSizeDraft(String(gridSize));
  }, [gridSize]);

  // --- Draw --------------------------------------------------------------
  const draw = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const n = gridSizeRef.current;

    ctx.fillStyle = "#120f0c";
    ctx.fillRect(0, 0, w, h);

    const scale = scaleRef.current;
    const offset = offsetRef.current;

    if (offscreenRef.current) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        offscreenRef.current,
        -offset.x * scale,
        -offset.y * scale,
        n * scale,
        n * scale
      );
    }

    const startX = Math.max(0, Math.floor(offset.x));
    const startY = Math.max(0, Math.floor(offset.y));
    const endX = Math.min(n, Math.ceil(offset.x + w / scale) + 1);
    const endY = Math.min(n, Math.ceil(offset.y + h / scale) + 1);

    if (scale >= 14) {
      ctx.strokeStyle = "rgba(26, 23, 20, 0.09)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = startX; x <= endX; x++) {
        const px = Math.round((x - offset.x) * scale) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
      }
      for (let y = startY; y <= endY; y++) {
        const py = Math.round((y - offset.y) * scale) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
      }
      ctx.stroke();
    }

    // Outer border — helps at small N where the whole grid is in view.
    if (n <= 50 && scale >= 14) {
      ctx.strokeStyle = "rgba(26, 23, 20, 0.45)";
      ctx.lineWidth = 1.5;
      const bx = Math.round(-offset.x * scale) + 0.5;
      const by = Math.round(-offset.y * scale) + 0.5;
      ctx.strokeRect(bx, by, n * scale, n * scale);
    }

    if (showCountsRef.current && scale >= COUNT_MIN_SCALE) {
      const fontSize = Math.min(scale * 0.42, 14);
      ctx.font = `500 ${fontSize}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const cells = cellsRef.current;
      const counts = countsRef.current;
      let lastColor = "";
      for (let y = startY; y < endY; y++) {
        const row = y * n;
        for (let x = startX; x < endX; x++) {
          const idx = row + x;
          const c = counts[idx];
          if (c === 0) continue;
          const color = PALETTE_TEXT_LIGHT[cells[idx]]
            ? COLOR_COUNT_ON_DARK
            : COLOR_COUNT_ON_LIGHT;
          if (color !== lastColor) {
            ctx.fillStyle = color;
            lastColor = color;
          }
          const cx = (x + 0.5 - offset.x) * scale;
          const cy = (y + 0.5 - offset.y) * scale;
          ctx.fillText(String(c), cx, cy);
        }
      }
    }

    const ants = antsRef.current;
    const pad = Math.max(1, scale * 0.14);
    for (let i = 0; i < ants.length; i++) {
      const ant = ants[i];
      const ax = (ant.x - offset.x) * scale;
      const ay = (ant.y - offset.y) * scale;
      if (ax + scale <= 0 || ax >= w || ay + scale <= 0 || ay >= h) continue;
      ctx.fillStyle =
        ant.type === "regular" ? COLOR_ANT_REGULAR : COLOR_ANT_INVERSE;
      ctx.fillRect(ax + pad, ay + pad, scale - pad * 2, scale - pad * 2);
    }

    ctx.fillStyle = COLOR_BG;
    for (let i = 0; i < ants.length; i++) {
      const ant = ants[i];
      const ax = (ant.x - offset.x) * scale;
      const ay = (ant.y - offset.y) * scale;
      if (ax + scale <= 0 || ax >= w || ay + scale <= 0 || ay >= h) continue;
      ctx.beginPath();
      const cx = ax + scale / 2;
      const cy = ay + scale / 2;
      const ts = Math.max(1.5, scale * 0.22);
      if (ant.dir === 0) {
        ctx.moveTo(cx, cy - ts);
        ctx.lineTo(cx - ts * 0.7, cy + ts * 0.5);
        ctx.lineTo(cx + ts * 0.7, cy + ts * 0.5);
      } else if (ant.dir === 1) {
        ctx.moveTo(cx + ts, cy);
        ctx.lineTo(cx - ts * 0.5, cy - ts * 0.7);
        ctx.lineTo(cx - ts * 0.5, cy + ts * 0.7);
      } else if (ant.dir === 2) {
        ctx.moveTo(cx, cy + ts);
        ctx.lineTo(cx - ts * 0.7, cy - ts * 0.5);
        ctx.lineTo(cx + ts * 0.7, cy - ts * 0.5);
      } else {
        ctx.moveTo(cx - ts, cy);
        ctx.lineTo(cx + ts * 0.5, cy - ts * 0.7);
        ctx.lineTo(cx + ts * 0.5, cy + ts * 0.7);
      }
      ctx.closePath();
      ctx.fill();
    }
  }, []);

  // --- Simulation step ---------------------------------------------------
  const step = useCallback(
    (
      n: number
    ): {
      removed: boolean;
      allGone: boolean;
      paintedChanged: boolean;
      cycleDetected: boolean;
    } => {
      const cells = cellsRef.current;
      const counts = countsRef.current;
      const ants = antsRef.current;
      const oc = offscreenRef.current;
      const N = gridSizeRef.current;
      if (!oc)
        return {
          removed: false,
          allGone: ants.length === 0,
          paintedChanged: false,
          cycleDetected: false,
        };
      const octx = oc.getContext("2d");
      if (!octx)
        return {
          removed: false,
          allGone: ants.length === 0,
          paintedChanged: false,
          cycleDetected: false,
        };

      // On the first state-changing step since clear/resize, freeze the
      // current configuration as the Reset target. This is the moment that
      // turns the user's edits ("paint these cells, place these ants")
      // into a committed starting point.
      if (
        n > 0 &&
        ants.length > 0 &&
        stepCountRef.current === 0 &&
        initialStateRef.current === null
      ) {
        initialStateRef.current = {
          cells: new Uint8Array(cells),
          ants: ants.map((a) => ({ ...a })),
          nextAntId: nextAntIdRef.current,
          paintedCount: paintedCountRef.current,
        };
        setHasSnapshot(true);
      }

      const torusOn = torusRef.current;
      let removed = false;
      let paintedDelta = 0;
      let steps = 0;
      let cycleDetected = false;
      const cellCounts = new Map<number, number>();

      // Cycle detection is gated by grid size — hashing cost scales with
      // cell count, and cycles on large grids are astronomical. We also
      // re-check `cycleInfoRef.current === null` each iteration below,
      // since detection may fire mid-batch.
      const gridOkForCycle = N <= MAX_CYCLE_GRID;

      // Seed the hash table with the current state if it's empty — this
      // covers both step 0 of a new run AND any trajectory break where
      // we flushed the table (cell paint, ant edit, etc.).
      if (
        gridOkForCycle &&
        cycleInfoRef.current === null &&
        ants.length > 0 &&
        stateHashesRef.current.size === 0
      ) {
        stateHashesRef.current.set(
          hashState(cells, ants),
          stepCountRef.current
        );
      }

      for (let i = 0; i < n; i++) {
        if (ants.length === 0) break;

        // Phase 1: each ant reads its (pre-advance) cell color and turns
        // according to the rule for that color. Inverse ants swap L↔R;
        // N (no turn) and U (u-turn) are unchanged.
        const ruleArr = rulesRef.current;
        for (let k = 0; k < ants.length; k++) {
          const ant = ants[k];
          const idx = ant.y * N + ant.x;
          const color = cells[idx];
          let turn: TurnAction = ruleArr[color];
          if (ant.type === "inverse") {
            if (turn === "L") turn = "R";
            else if (turn === "R") turn = "L";
          }
          if (turn === "L") ant.dir = (ant.dir + 3) & 3;
          else if (turn === "R") ant.dir = (ant.dir + 1) & 3;
          else if (turn === "U") ant.dir = (ant.dir + 2) & 3;
          // 'N' = no turn, leave ant.dir alone
        }

        // Phase 2: tally ants per cell; advance each visited cell by
        // applying the (user-editable) transition map once per ant that
        // landed on it. With the default cyclic transitions this matches
        // the classic multi-color Langton's ant (color += count, mod N);
        // with edited transitions it can be any directed graph on colors.
        cellCounts.clear();
        for (let k = 0; k < ants.length; k++) {
          const a = ants[k];
          const idx = a.y * N + a.x;
          cellCounts.set(idx, (cellCounts.get(idx) ?? 0) + 1);
        }
        const trans = transitionsRef.current;
        cellCounts.forEach((cnt, idx) => {
          counts[idx] += cnt;
          const oldVal = cells[idx];
          // Iterate the transition `cnt` times. Each ant visit applies
          // the transition once, matching the semantic of "ants take
          // turns leaving" even though we resolve them in one tick.
          let newVal = oldVal;
          for (let j = 0; j < cnt; j++) newVal = trans[newVal];
          if (newVal !== oldVal) {
            // Painted = any color other than 0 (the cream background).
            const wasPainted = oldVal !== 0;
            const isPainted = newVal !== 0;
            if (!wasPainted && isPainted) paintedDelta++;
            else if (wasPainted && !isPainted) paintedDelta--;
            cells[idx] = newVal;
            octx.fillStyle = PALETTE[newVal];
            octx.fillRect(idx % N, Math.floor(idx / N), 1, 1);
            // Audio: play the note for the *destination* color. The synth
            // internally debounces per-pitch so flooding here is fine.
            synthRef.current?.play(newVal);
          }
        });

        // Phase 3: all ants advance.
        for (let k = 0; k < ants.length; k++) {
          const a = ants[k];
          a.x += DX[a.dir];
          a.y += DY[a.dir];
          if (torusOn) {
            if (a.x < 0) a.x += N;
            else if (a.x >= N) a.x -= N;
            if (a.y < 0) a.y += N;
            else if (a.y >= N) a.y -= N;
          }
        }

        // Phase 4: remove any ants that left the board.
        if (!torusOn) {
          for (let k = ants.length - 1; k >= 0; k--) {
            const a = ants[k];
            if (a.x < 0 || a.x >= N || a.y < 0 || a.y >= N) {
              ants.splice(k, 1);
              removed = true;
            }
          }
        }

        steps++;
        if (ants.length === 0) break;

        // Cycle detection: hash the fresh post-step state and see if we've
        // stood in these exact shoes before. Once found, stop adding new
        // entries — the badge stays visible and the table stops growing.
        if (gridOkForCycle && cycleInfoRef.current === null) {
          const currentStep = stepCountRef.current + steps;
          const hash = hashState(cells, ants);
          const seenAt = stateHashesRef.current.get(hash);
          if (seenAt !== undefined) {
            cycleInfoRef.current = {
              length: currentStep - seenAt,
              firstSeenAtStep: seenAt,
              detectedAtStep: currentStep,
            };
            cycleDetected = true;
          } else {
            stateHashesRef.current.set(hash, currentStep);
          }
        }
      }

      stepCountRef.current += steps;
      if (paintedDelta !== 0) paintedCountRef.current += paintedDelta;
      return {
        removed,
        allGone: ants.length === 0,
        paintedChanged: paintedDelta !== 0,
        cycleDetected,
      };
    },
    []
  );

  // Helper: flush cycle detection state. Called whenever the trajectory is
  // broken (cell paint, ant edit, torus toggle) — past hashes no longer
  // apply to the new dynamics. Does NOT clear the badge; use
  // resetCycleBadge() for that (or Clear/Reset/Resize which reset both).
  const flushCycleHashes = useCallback((): void => {
    stateHashesRef.current.clear();
  }, []);

  const resetCycleBadge = useCallback((): void => {
    stateHashesRef.current.clear();
    cycleInfoRef.current = null;
    setCycleInfo(null);
  }, []);

  // --- Ant helpers -------------------------------------------------------
  const findAntIdAt = useCallback((gx: number, gy: number): number | null => {
    const ants = antsRef.current;
    for (let i = ants.length - 1; i >= 0; i--) {
      if (ants[i].x === gx && ants[i].y === gy) return ants[i].id;
    }
    return null;
  }, []);

  const findAntIndexById = useCallback((id: number): number => {
    const ants = antsRef.current;
    for (let i = 0; i < ants.length; i++) if (ants[i].id === id) return i;
    return -1;
  }, []);

  // --- View helpers ------------------------------------------------------
  const fitToGrid = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const n = gridSizeRef.current;
    const fit = (Math.min(rect.width, rect.height) / n) * FIT_PADDING;
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit));
    scaleRef.current = clamped;
    setScaleDisplay(clamped);
    offsetRef.current = {
      x: n / 2 - rect.width / clamped / 2,
      y: n / 2 - rect.height / clamped / 2,
    };
  }, []);

  const centerOnAnts = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ants = antsRef.current;
    const n = gridSizeRef.current;
    let cx = n / 2;
    let cy = n / 2;
    if (ants.length > 0) {
      let sx = 0;
      let sy = 0;
      for (const a of ants) {
        sx += a.x;
        sy += a.y;
      }
      cx = sx / ants.length + 0.5;
      cy = sy / ants.length + 0.5;
    }
    offsetRef.current = {
      x: cx - rect.width / scaleRef.current / 2,
      y: cy - rect.height / scaleRef.current / 2,
    };
    draw();
  }, [draw]);

  // --- Grid size change: rebuild simulation state ------------------------
  useEffect(() => {
    const n = gridSize;
    gridSizeRef.current = n;
    cellsRef.current = new Uint8Array(n * n);
    countsRef.current = new Uint32Array(n * n);
    antsRef.current = makeInitialAnts(n);
    nextAntIdRef.current = 2;
    stepCountRef.current = 0;
    paintedCountRef.current = 0;
    initialStateRef.current = null; // invalidate — new grid, fresh start
    stateHashesRef.current.clear();
    cycleInfoRef.current = null;

    const oc = document.createElement("canvas");
    oc.width = n;
    oc.height = n;
    const octx = oc.getContext("2d");
    if (octx) {
      octx.fillStyle = COLOR_BG;
      octx.fillRect(0, 0, n, n);
    }
    offscreenRef.current = oc;

    setStepCount(0);
    setPaintedCount(0);
    setRunning(false);
    setHasStarted(false);
    setHasSnapshot(false);
    setCycleInfo(null);
    setAntVersion((v) => v + 1);

    fitToGrid();
    draw();
  }, [gridSize, fitToGrid, draw]);

  // --- Canvas sizing -----------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;
      }
      fitToGrid();
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    window.addEventListener("resize", resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [fitToGrid, draw]);

  // --- Animation loop ----------------------------------------------------
  useEffect(() => {
    const loop = () => {
      if (!runningRef.current) return;
      stepAccumulatorRef.current += SPEEDS[speedRef.current];
      const whole = Math.floor(stepAccumulatorRef.current);
      let removed = false;
      let allGone = false;
      let paintedChanged = false;
      let cycleDetected = false;
      if (whole > 0) {
        stepAccumulatorRef.current -= whole;
        const res = step(whole);
        removed = res.removed;
        allGone = res.allGone;
        paintedChanged = res.paintedChanged;
        cycleDetected = res.cycleDetected;
      }
      draw();
      if (whole > 0) setStepCount(stepCountRef.current);
      if (paintedChanged) setPaintedCount(paintedCountRef.current);
      if (removed) setAntVersion((v) => v + 1);
      if (cycleDetected) setCycleInfo(cycleInfoRef.current);
      if (allGone) {
        runningRef.current = false;
        setRunning(false);
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    if (running) {
      runningRef.current = true;
      setHasStarted(true);
      stepAccumulatorRef.current = 1;
      rafRef.current = requestAnimationFrame(loop);
    } else {
      runningRef.current = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      draw();
    }
    return () => {
      runningRef.current = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [running, draw, step]);

  useEffect(() => {
    speedRef.current = speedIdx;
  }, [speedIdx]);

  useEffect(() => {
    showCountsRef.current = showCounts;
    draw();
  }, [showCounts, draw]);

  useEffect(() => {
    torusRef.current = torus;
    // Toggling wrap changes the dynamics — any past hashes were collected
    // under the old rules and could produce false cycles. Drop the badge
    // too since it was detected under those old rules.
    resetCycleBadge();
  }, [torus, resetCycleBadge]);

  useEffect(() => {
    rulesRef.current = rules;
    // Rules govern dynamics. Past hashes don't apply to the new dynamics,
    // and any badge we were showing was for the old rules.
    resetCycleBadge();
  }, [rules, resetCycleBadge]);

  useEffect(() => {
    transitionsRef.current = transitions;
    // Transitions govern color dynamics — same logic as rules: past hashes
    // were computed under different dynamics and can no longer match.
    resetCycleBadge();
  }, [transitions, resetCycleBadge]);

  // Sync the sound-on flag into the synth (which checks it before scheduling
  // any audio). Also dispose the AudioContext on unmount so we don't leak.
  useEffect(() => {
    if (synthRef.current) synthRef.current.enabled = soundOn;
  }, [soundOn]);

  // Push the per-color frequencies into the synth whenever notes change.
  // Doing the Math.pow once here (12 times) saves doing it in the audio
  // hot path on every cell flip.
  useEffect(() => {
    synthRef.current?.setNoteFrequencies(notes.map(midiToFreq));
  }, [notes]);

  useEffect(() => {
    return () => {
      synthRef.current?.dispose();
    };
  }, []);

  // Keep the editable rule-string draft in sync when rules change from
  // outside (e.g. preset selection or individual button taps).
  useEffect(() => {
    setRulesDraft(rulesToString(rules));
  }, [rules]);

  // --- Controls ----------------------------------------------------------
  // Reset: rewind to the snapshot taken just before the first step of the
  // current run. No-op if no snapshot exists yet (user hasn't played since
  // the last clear/resize) — the button is disabled in that case.
  const reset = useCallback((): void => {
    const snap = initialStateRef.current;
    if (snap === null) return;

    const n = gridSizeRef.current;
    cellsRef.current.set(snap.cells); // in-place copy; snap stays intact
    countsRef.current.fill(0); // visit counts are historical — zero them
    antsRef.current = snap.ants.map((a) => ({ ...a }));
    nextAntIdRef.current = snap.nextAntId;
    stepCountRef.current = 0;
    paintedCountRef.current = snap.paintedCount;

    setStepCount(0);
    setPaintedCount(snap.paintedCount);
    setRunning(false);
    setHasStarted(false);
    setAntVersion((v) => v + 1);
    // A rewind starts the trajectory over from the snapshot state, so
    // past hashes don't apply. Drop the badge — detection starts fresh.
    resetCycleBadge();

    // Repaint the offscreen cache to reflect the restored cells.
    const oc = offscreenRef.current;
    if (oc) {
      const octx = oc.getContext("2d");
      if (octx) {
        // Start by filling with palette[0] (the background), then paint
        // any non-zero cells individually — switching fillStyle only when
        // the color changes for a slight batching win.
        octx.fillStyle = PALETTE[0];
        octx.fillRect(0, 0, n, n);
        const cells = cellsRef.current;
        let lastColor = -1;
        for (let i = 0; i < cells.length; i++) {
          const c = cells[i];
          if (c === 0) continue;
          if (c !== lastColor) {
            octx.fillStyle = PALETTE[c];
            lastColor = c;
          }
          octx.fillRect(i % n, Math.floor(i / n), 1, 1);
        }
      }
    }

    draw();
  }, [draw, resetCycleBadge]);

  // Clear: blank board with a single regular ant centered facing up.
  // Invalidates the snapshot so the next Play captures a fresh one.
  const clear = useCallback((): void => {
    const n = gridSizeRef.current;
    cellsRef.current.fill(0);
    countsRef.current.fill(0);
    antsRef.current = makeInitialAnts(n);
    nextAntIdRef.current = 2;
    stepCountRef.current = 0;
    paintedCountRef.current = 0;
    initialStateRef.current = null;

    setStepCount(0);
    setPaintedCount(0);
    setRunning(false);
    setHasStarted(false);
    setHasSnapshot(false);
    setAntVersion((v) => v + 1);
    resetCycleBadge();

    const oc = offscreenRef.current;
    if (oc) {
      const octx = oc.getContext("2d");
      if (octx) {
        octx.fillStyle = COLOR_BG;
        octx.fillRect(0, 0, n, n);
      }
    }
    fitToGrid();
    draw();
  }, [fitToGrid, draw, resetCycleBadge]);

  const stepOnce = useCallback((): void => {
    if (running || antsRef.current.length === 0) return;
    const { removed, allGone, paintedChanged, cycleDetected } = step(1);
    draw();
    setStepCount(stepCountRef.current);
    if (paintedChanged) setPaintedCount(paintedCountRef.current);
    setHasStarted(true);
    if (removed) setAntVersion((v) => v + 1);
    if (cycleDetected) setCycleInfo(cycleInfoRef.current);
    if (allGone) setRunning(false);
  }, [running, step, draw]);

  const addAnt = useCallback(
    (type: AntType): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scale = scaleRef.current;
      const n = gridSizeRef.current;
      const cx = Math.floor(offsetRef.current.x + rect.width / scale / 2);
      const cy = Math.floor(offsetRef.current.y + rect.height / scale / 2);
      const x = Math.max(0, Math.min(n - 1, cx));
      const y = Math.max(0, Math.min(n - 1, cy));
      antsRef.current.push({
        id: nextAntIdRef.current++,
        x,
        y,
        dir: 0,
        type,
      });
      setAntVersion((v) => v + 1);
      // Spawning an ant breaks the current trajectory — past hashes aren't
      // comparable anymore. Keep any existing badge (it was legit) but
      // drop the hashes so future detections restart from here.
      flushCycleHashes();
      draw();
    },
    [draw, flushCycleHashes]
  );

  const zoomAt = useCallback(
    (factor: number, sx?: number, sy?: number): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (sx === undefined) sx = rect.width / 2;
      if (sy === undefined) sy = rect.height / 2;
      const oldScale = scaleRef.current;
      const newScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, oldScale * factor)
      );
      if (newScale === oldScale) return;
      offsetRef.current.x += sx * (1 / oldScale - 1 / newScale);
      offsetRef.current.y += sy * (1 / oldScale - 1 / newScale);
      scaleRef.current = newScale;
      setScaleDisplay(newScale);
      draw();
    },
    [draw]
  );

  const bumpSize = useCallback((delta: number): void => {
    setGridSize((s) => clampGrid(s + delta));
  }, []);

  const commitSizeDraft = useCallback((): void => {
    const parsed = parseInt(sizeDraft, 10);
    const next = clampGrid(Number.isFinite(parsed) ? parsed : DEFAULT_GRID);
    setGridSize(next);
    setSizeDraft(String(next));
  }, [sizeDraft]);

  // Replace the rule for a single color slot, leaving the other 11 alone.
  const setRuleAt = useCallback(
    (colorIndex: number, action: TurnAction): void => {
      setRules((prev) => {
        if (prev[colorIndex] === action) return prev;
        const next = prev.slice();
        next[colorIndex] = action;
        return next;
      });
    },
    []
  );

  // Commit the freeform rule-string text box — parses it (padding/trimming
  // to 12 chars, coercing unknowns to 'R') and applies as the active rules.
  const commitRulesDraft = useCallback((): void => {
    setRules(parseRules(rulesDraft));
  }, [rulesDraft]);

  const applyRulePreset = useCallback((s: string): void => {
    setRules(parseRules(s));
  }, []);

  // Edit a single color's note by adding `delta` semitones, clamped to the
  // audible range. Wake the audio context too — this is a user gesture and
  // tapping the ± buttons should be enough to start the audio for first-time
  // listeners who haven't pressed Play yet.
  const bumpNote = useCallback((colorIdx: number, delta: number): void => {
    synthRef.current?.resume();
    setNotes((prev) => {
      const cur = prev[colorIdx];
      const next = clampMidi(cur + delta);
      if (next === cur) return prev;
      const out = prev.slice();
      out[colorIdx] = next;
      return out;
    });
  }, []);

  const resetNotesToDefault = useCallback((): void => {
    setNotes(DEFAULT_NOTES.slice());
  }, []);

  // Edit a single color's destination by adding `delta` to the destination
  // index, wrapping modulo NUM_COLORS. This is consistent with the cyclic
  // default: ± moves the destination through the natural color order.
  const bumpTransition = useCallback(
    (colorIdx: number, delta: number): void => {
      setTransitions((prev) => {
        const cur = prev[colorIdx];
        const next = (((cur + delta) % NUM_COLORS) + NUM_COLORS) % NUM_COLORS;
        if (next === cur) return prev;
        const out = prev.slice();
        out[colorIdx] = next;
        return out;
      });
    },
    []
  );

  const resetTransitionsToDefault = useCallback((): void => {
    setTransitions(DEFAULT_TRANSITIONS.slice());
  }, []);

  // --- Pointer gestures --------------------------------------------------
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 1) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const gx = Math.floor(sx / scaleRef.current + offsetRef.current.x);
      const gy = Math.floor(sy / scaleRef.current + offsetRef.current.y);
      const antId = !runningRef.current ? findAntIdAt(gx, gy) : null;

      let longPressTimer: number | null = null;
      if (antId !== null) {
        const targetId = antId;
        longPressTimer = window.setTimeout(() => {
          const ds = dragStateRef.current;
          if (
            ds?.type === "tap" &&
            ds.antId === targetId &&
            !ds.consumed &&
            !runningRef.current
          ) {
            const idx = findAntIndexById(targetId);
            if (idx !== -1) {
              antsRef.current.splice(idx, 1);
              setAntVersion((v) => v + 1);
              flushCycleHashes(); // ant removed → trajectory break
              draw();
            }
            ds.consumed = true;
          }
        }, LONG_PRESS_MS);
      }

      dragStateRef.current = {
        type: "tap",
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        antId,
        longPressTimer,
        consumed: false,
      };
    } else if (pointersRef.current.size === 2) {
      const prev = dragStateRef.current;
      if (prev?.type === "tap" && prev.longPressTimer !== null) {
        window.clearTimeout(prev.longPressTimer);
      }
      const pts = [...pointersRef.current.values()];
      const p1 = pts[0];
      const p2 = pts[1];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      dragStateRef.current = {
        type: "pinch",
        startDist: dist,
        startScale: scaleRef.current,
        cx: (p1.x + p2.x) / 2,
        cy: (p1.y + p2.y) / 2,
        startOffset: { ...offsetRef.current },
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const existing = pointersRef.current.get(e.pointerId);
    if (!existing) return;
    existing.x = e.clientX;
    existing.y = e.clientY;

    const ds = dragStateRef.current;
    if (!ds) return;

    if (ds.type === "tap" && !ds.consumed) {
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (Math.hypot(dx, dy) > TAP_MOVEMENT_PX) {
        if (ds.longPressTimer !== null) window.clearTimeout(ds.longPressTimer);
        if (ds.antId !== null && !runningRef.current) {
          dragStateRef.current = { type: "dragAnt", antId: ds.antId };
        } else {
          dragStateRef.current = {
            type: "pan",
            lastX: ds.lastX,
            lastY: ds.lastY,
          };
        }
      }
    }

    const curr = dragStateRef.current;
    if (!curr) return;

    if (curr.type === "pan") {
      const dx = e.clientX - curr.lastX;
      const dy = e.clientY - curr.lastY;
      offsetRef.current.x -= dx / scaleRef.current;
      offsetRef.current.y -= dy / scaleRef.current;
      curr.lastX = e.clientX;
      curr.lastY = e.clientY;
      if (!runningRef.current) draw();
    } else if (curr.type === "dragAnt") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const gx = Math.floor(sx / scaleRef.current + offsetRef.current.x);
      const gy = Math.floor(sy / scaleRef.current + offsetRef.current.y);
      const n = gridSizeRef.current;
      const cx = Math.max(0, Math.min(n - 1, gx));
      const cy = Math.max(0, Math.min(n - 1, gy));
      const idx = findAntIndexById(curr.antId);
      if (idx !== -1) {
        const ant = antsRef.current[idx];
        if (ant.x !== cx || ant.y !== cy) {
          ant.x = cx;
          ant.y = cy;
          flushCycleHashes(); // ant moved → trajectory break
          draw();
        }
      }
    } else if (curr.type === "pinch" && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()];
      const p1 = pts[0];
      const p2 = pts[1];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const ratio = dist / curr.startDist;
      const newScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, curr.startScale * ratio)
      );
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx0 = curr.cx - rect.left;
      const cy0 = curr.cy - rect.top;
      const cxNow = (p1.x + p2.x) / 2 - rect.left;
      const cyNow = (p1.y + p2.y) / 2 - rect.top;
      const oldScale = curr.startScale;
      offsetRef.current.x =
        curr.startOffset.x + cx0 / oldScale - cxNow / newScale;
      offsetRef.current.y =
        curr.startOffset.y + cy0 / oldScale - cyNow / newScale;
      scaleRef.current = newScale;
      setScaleDisplay(newScale);
      if (!runningRef.current) draw();
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const ds = dragStateRef.current;
    if (ds?.type === "tap" && ds.longPressTimer !== null) {
      window.clearTimeout(ds.longPressTimer);
    }

    if (
      ds?.type === "tap" &&
      !ds.consumed &&
      pointersRef.current.size === 1 &&
      pointersRef.current.has(e.pointerId)
    ) {
      if (ds.antId === null) {
        // Tap on empty cell → toggle; update black count.
        const canvas = canvasRef.current;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const n = gridSizeRef.current;
          const gx = Math.floor(sx / scaleRef.current + offsetRef.current.x);
          const gy = Math.floor(sy / scaleRef.current + offsetRef.current.y);
          if (gx >= 0 && gx < n && gy >= 0 && gy < n) {
            const idx = gy * n + gx;
            // Tap-to-paint deliberately cycles by simple +1 mod 12 rather
            // than following the user-edited transition map. The reason:
            // painting is a manual tool to ACCESS any of the 12 colors, so
            // it shouldn't be hostage to whatever cycle (or self-loop) the
            // user defined in transitions. The simulation uses transitions;
            // this control uses cycling.
            const oldVal = cellsRef.current[idx];
            const newVal = (oldVal + 1) % NUM_COLORS;
            cellsRef.current[idx] = newVal;
            const wasPainted = oldVal !== 0;
            const isPainted = newVal !== 0;
            if (!wasPainted && isPainted) paintedCountRef.current++;
            else if (wasPainted && !isPainted) paintedCountRef.current--;
            setPaintedCount(paintedCountRef.current);
            const oc = offscreenRef.current;
            if (oc) {
              const octx = oc.getContext("2d");
              if (octx) {
                octx.fillStyle = PALETTE[newVal];
                octx.fillRect(gx, gy, 1, 1);
              }
            }
            // The tap is itself a user gesture, so this is a safe moment
            // to wake the AudioContext if it was still suspended.
            synthRef.current?.resume();
            synthRef.current?.play(newVal);
            flushCycleHashes(); // cell changed → trajectory break
            draw();
          }
        }
      }
    }

    pointersRef.current.delete(e.pointerId);

    if (pointersRef.current.size === 0) {
      dragStateRef.current = null;
    } else if (
      pointersRef.current.size === 1 &&
      dragStateRef.current?.type === "pinch"
    ) {
      const remaining = [...pointersRef.current.values()][0];
      dragStateRef.current = {
        type: "pan",
        lastX: remaining.x,
        lastY: remaining.y,
      };
    }
  };

  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(factor, sx, sy);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const prevent = (ev: Event) => ev.preventDefault();
    canvas.addEventListener("wheel", prevent, { passive: false });
    canvas.addEventListener("touchmove", prevent, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", prevent);
      canvas.removeEventListener("touchmove", prevent);
    };
  }, []);

  // --- Derived values ----------------------------------------------------
  // Zoom readout is relative to the natural fit scale so 100% ≈ "fit".
  // Computed against a reference of 34 for consistency with prior versions,
  // but is really just a rough indicator — users can read the grid directly.
  const zoomPct = Math.round((scaleDisplay / 34) * 100);

  const antStats = useMemo(() => {
    const a = antsRef.current;
    let regular = 0;
    let inverse = 0;
    for (const x of a) {
      if (x.type === "regular") regular++;
      else inverse++;
    }
    return { total: a.length, regular, inverse };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [antVersion]);
  const noAnts = antStats.total === 0;
  const totalCells = gridSize * gridSize;

  // --- Render ------------------------------------------------------------
  const rulesPanelBody = (
    <div className="p-6 sm:p-7 pb-[max(env(safe-area-inset-bottom),1.75rem)]">
      <h2 className="ff-display italic text-3xl leading-none mb-1">
        Color rules
      </h2>
      <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-5">
        {NUM_COLORS} colors · note, turn &amp; destination per color
      </p>

      <p className="text-[13px] leading-relaxed opacity-75 mb-5">
        Each row sets the <b>note</b> that plays, the <b>turn</b>{" "}
        the ant takes, and the <b>destination color</b> the cell
        becomes when an ant lands on that color and leaves.{" "}
        <span className="ff-mono">L</span> = left,{" "}
        <span className="ff-mono">R</span> = right,{" "}
        <span className="ff-mono">N</span> = no turn,{" "}
        <span className="ff-mono">U</span> = u-turn.
      </p>

      {/* Per-color rule rows */}
      <div className="flex flex-col gap-1.5">
        {rules.map((action, i) => {
          const dest = transitions[i];
          const lightText = PALETTE_TEXT_LIGHT[i];
          return (
            <div
              key={i}
              className="flex items-center gap-1.5"
              role="group"
              aria-label={`Color ${i} note, turn rule, and destination`}
            >
              {/* Color N badge */}
              <span
                className="ff-mono text-[12px] tabular-nums font-semibold w-7 h-7 flex items-center justify-center rounded-sm flex-shrink-0"
                style={{
                  background: PALETTE[i],
                  color: lightText ? COLOR_TEXT : COLOR_INK,
                  border: "1px solid rgba(26,23,20,0.18)",
                }}
              >
                {i}
              </span>

              {/* Note stepper for this color — − [name] + */}
              <div
                className="flex items-stretch flex-shrink-0 border border-[#1a1714]/15 rounded-sm overflow-hidden"
                role="group"
                aria-label={`Color ${i} note`}
              >
                <button
                  onClick={() => bumpNote(i, -1)}
                  disabled={notes[i] <= MIN_MIDI}
                  className="w-5 flex items-center justify-center hover:bg-black/5 disabled:opacity-25 disabled:cursor-not-allowed"
                  aria-label={`Color ${i}: note down a semitone`}
                >
                  <Minus size={10} strokeWidth={2.25} />
                </button>
                <span
                  className="ff-mono text-[10.5px] tabular-nums px-1.5 self-center min-w-[2.25rem] text-center select-none"
                  title={`Plays ${midiToName(notes[i])} (${midiToFreq(notes[i]).toFixed(1)} Hz)`}
                >
                  {midiToName(notes[i])}
                </span>
                <button
                  onClick={() => bumpNote(i, 1)}
                  disabled={notes[i] >= MAX_MIDI}
                  className="w-5 flex items-center justify-center hover:bg-black/5 disabled:opacity-25 disabled:cursor-not-allowed"
                  aria-label={`Color ${i}: note up a semitone`}
                >
                  <Plus size={10} strokeWidth={2.25} />
                </button>
              </div>

              {/* Turn action segmented control */}
              <div className="flex items-stretch flex-1 rounded-sm overflow-hidden border border-[#1a1714]/15">
                {TURN_ACTIONS.map((opt) => {
                  const isActive = action === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setRuleAt(i, opt)}
                      aria-pressed={isActive}
                      aria-label={`Color ${i} ${opt === "L" ? "left" : opt === "R" ? "right" : opt === "N" ? "no turn" : "u-turn"}`}
                      className={`flex-1 ff-mono text-[12.5px] font-semibold h-7 flex items-center justify-center transition ${
                        isActive
                          ? ""
                          : "opacity-40 hover:opacity-70 hover:bg-black/5"
                      }`}
                      style={
                        isActive
                          ? {
                              background: COLOR_INK,
                              color: COLOR_TEXT,
                            }
                          : { background: "transparent" }
                      }
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>

              {/* Destination stepper — − [dest color badge] +
                  Drives the cell's color after this row's color
                  is visited by an ant. Steps modulo NUM_COLORS. */}
              <div
                className="flex items-stretch flex-shrink-0 border border-[#1a1714]/15 rounded-sm overflow-hidden"
                role="group"
                aria-label={`Color ${i} destination`}
              >
                <button
                  onClick={() => bumpTransition(i, -1)}
                  className="w-4 flex items-center justify-center hover:bg-black/5"
                  aria-label={`Color ${i}: previous destination color`}
                >
                  <Minus size={9} strokeWidth={2.25} />
                </button>
                <span
                  className="ff-mono text-[11px] tabular-nums w-6 flex items-center justify-center select-none"
                  style={{
                    background: PALETTE[dest],
                    color: PALETTE_TEXT_LIGHT[dest]
                      ? COLOR_TEXT
                      : COLOR_INK,
                  }}
                  title={`Becomes color ${dest} after an ant leaves`}
                >
                  {dest}
                </span>
                <button
                  onClick={() => bumpTransition(i, 1)}
                  className="w-4 flex items-center justify-center hover:bg-black/5"
                  aria-label={`Color ${i}: next destination color`}
                >
                  <Plus size={9} strokeWidth={2.25} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Reset affordances — both show only when modified.
          Subtle one-tap escape hatches when you've drifted too
          far from a clean starting point. */}
      {(notes.some((n, i) => n !== DEFAULT_NOTES[i]) ||
        transitions.some((t, i) => t !== DEFAULT_TRANSITIONS[i])) && (
        <div className="mt-3 flex justify-end gap-3">
          {transitions.some(
            (t, i) => t !== DEFAULT_TRANSITIONS[i]
          ) && (
            <button
              onClick={resetTransitionsToDefault}
              className="ff-mono text-[10.5px] tracking-wide opacity-55 hover:opacity-90 transition flex items-center gap-1"
              title="Reset all destinations to the cyclic default (N → N+1)"
            >
              <RotateCcw size={11} strokeWidth={1.75} />
              reset transitions
            </button>
          )}
          {notes.some((n, i) => n !== DEFAULT_NOTES[i]) && (
            <button
              onClick={resetNotesToDefault}
              className="ff-mono text-[10.5px] tracking-wide opacity-55 hover:opacity-90 transition flex items-center gap-1"
              title="Reset all notes to the chromatic C4 → B4 default"
            >
              <RotateCcw size={11} strokeWidth={1.75} />
              reset notes
            </button>
          )}
        </div>
      )}

      {/* Freeform rule string editor */}
      <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
        <label className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 block mb-2">
          Rule string
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={rulesDraft}
            maxLength={NUM_COLORS}
            onChange={(e) =>
              setRulesDraft(e.target.value.toUpperCase())
            }
            onBlur={commitRulesDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                setRulesDraft(rulesToString(rules));
                e.currentTarget.blur();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            autoCapitalize="characters"
            autoCorrect="off"
            className="ff-mono text-[14px] tracking-[0.1em] tabular-nums flex-1 px-3 py-2 rounded-sm border border-[#1a1714]/20 outline-none focus:border-[#1a1714]/50 bg-transparent"
            aria-label="Rule string"
          />
        </div>
        <p className="ff-mono text-[10px] opacity-45 mt-1.5">
          12 chars · L R N U · invalid chars become R
        </p>
      </div>

      {/* Presets */}
      <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
        <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
          Presets
        </p>
        <div className="flex flex-wrap gap-1.5">
          {RULE_PRESETS.map((p) => {
            const isActive = rulesToString(rules) === p.rules;
            return (
              <button
                key={p.name}
                onClick={() => applyRulePreset(p.rules)}
                className={`px-2.5 py-1.5 rounded-sm text-[12px] transition flex items-center gap-2 ${
                  isActive
                    ? ""
                    : "border border-[#1a1714]/15 opacity-65 hover:opacity-100 hover:bg-black/5"
                }`}
                style={
                  isActive
                    ? { background: COLOR_INK, color: COLOR_TEXT }
                    : { background: "transparent" }
                }
              >
                <span className="font-medium">{p.name}</span>
                <span className="ff-mono text-[10.5px] opacity-60 tracking-[0.06em]">
                  {p.rules}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .ff-display { font-family: 'Fraunces', 'Iowan Old Style', 'Palatino', serif; font-optical-sizing: auto; }
        .ff-mono    { font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace; }
        .app-canvas { touch-action: none; cursor: crosshair; user-select: none; -webkit-user-select: none; }
        .size-input {
          appearance: none; -moz-appearance: textfield;
          background: transparent; color: ${COLOR_TEXT};
          border: none; outline: none;
          text-align: center;
          font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
        }
        .size-input::-webkit-outer-spin-button, .size-input::-webkit-inner-spin-button {
          -webkit-appearance: none; margin: 0;
        }
        .size-input:focus { outline: 1px solid rgba(245,235,215,0.35); outline-offset: 1px; }
        .ant-range { -webkit-appearance: none; appearance: none; background: transparent; }
        .ant-range::-webkit-slider-runnable-track { height: 2px; background: rgba(245,235,215,0.18); border-radius: 999px; }
        .ant-range::-moz-range-track { height: 2px; background: rgba(245,235,215,0.18); border-radius: 999px; }
        .ant-range::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          height: 16px; width: 16px; border-radius: 999px;
          background: ${COLOR_ANT_REGULAR}; margin-top: -7px;
          border: 2px solid ${COLOR_INK};
          box-shadow: 0 0 0 1px rgba(245,235,215,0.25);
          cursor: pointer;
        }
        .ant-range::-moz-range-thumb {
          height: 16px; width: 16px; border-radius: 999px;
          background: ${COLOR_ANT_REGULAR}; border: 2px solid ${COLOR_INK};
          box-shadow: 0 0 0 1px rgba(245,235,215,0.25);
          cursor: pointer;
        }
        .spawn-btn { transition: transform 0.12s ease; }
        .spawn-btn:active { transform: scale(0.92); }
      `}</style>

      <div
        className="fixed inset-0 flex flex-col overflow-hidden"
        style={{ background: COLOR_INK, color: COLOR_TEXT }}
      >
        {/* Top bar */}
        <header className="flex items-center justify-between gap-2 sm:gap-3 px-3 sm:px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-1.5 sm:gap-2">
            <ToggleButton
              active={showCounts}
              onClick={() => setShowCounts((v) => !v)}
              label="Toggle visit counts"
              activeLabel="counts"
            >
              <Hash size={15} strokeWidth={2} />
            </ToggleButton>
            <ToggleButton
              active={torus}
              onClick={() => setTorus((v) => !v)}
              label="Toggle torus topology"
              activeLabel="wrap"
            >
              <InfinityIcon size={17} strokeWidth={2} />
            </ToggleButton>
            <ToggleButton
              active={soundOn}
              onClick={() => {
                // Toggling on doubles as a user gesture — resume the audio
                // context so the very next color change can play.
                if (!soundOn) synthRef.current?.resume();
                setSoundOn((v) => !v);
              }}
              label={soundOn ? "Mute" : "Unmute"}
              activeLabel="sound"
            >
              {soundOn ? (
                <Volume2 size={15} strokeWidth={2} />
              ) : (
                <VolumeX size={15} strokeWidth={2} />
              )}
            </ToggleButton>

            {/* Grid size stepper */}
            <div
              className="flex items-stretch border border-white/15 rounded-sm overflow-hidden h-9"
              role="group"
              aria-label="Grid size"
              title="Grid size (N × N)"
            >
              <button
                onClick={() => bumpSize(-1)}
                disabled={gridSize <= MIN_GRID}
                className="w-7 sm:w-8 flex items-center justify-center hover:bg-white/5 disabled:opacity-25 disabled:cursor-not-allowed"
                aria-label="Decrease grid size"
              >
                <Minus size={13} strokeWidth={2} />
              </button>
              <div className="flex items-baseline px-1 ff-mono text-[12px] tabular-nums">
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN_GRID}
                  max={MAX_GRID}
                  value={sizeDraft}
                  onChange={(e) => setSizeDraft(e.target.value)}
                  onBlur={commitSizeDraft}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") {
                      setSizeDraft(String(gridSize));
                      e.currentTarget.blur();
                    }
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  className="size-input w-9 self-center text-[12px]"
                  aria-label="Grid size N"
                />
                <span className="opacity-50 self-center text-[10px] mx-0.5">×</span>
                <span className="self-center">{gridSize}</span>
              </div>
              <button
                onClick={() => bumpSize(1)}
                disabled={gridSize >= MAX_GRID}
                className="w-7 sm:w-8 flex items-center justify-center hover:bg-white/5 disabled:opacity-25 disabled:cursor-not-allowed"
                aria-label="Increase grid size"
              >
                <Plus size={13} strokeWidth={2} />
              </button>
            </div>

            {/* Rules panel opener — shows the current rule string
                compactly on medium screens. Hidden on lg+ since the
                sidebar is always visible there and the button would just
                duplicate functionality. */}
            <button
              onClick={() => setShowRules(true)}
              className="lg:hidden h-9 px-2 sm:px-2.5 flex items-center gap-1.5 rounded-sm border border-white/15 opacity-70 hover:opacity-100 hover:bg-white/5 transition"
              aria-label="Edit color transition rules"
              title="Edit color transition rules"
            >
              <Palette size={14} strokeWidth={2} />
              <span className="ff-mono text-[10px] tracking-[0.05em] hidden md:inline">
                {rulesToString(rules)}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-3 sm:gap-4 flex-shrink-0">
            {/* Painted cell count — total cells with color > 0 */}
            <div className="ff-mono text-right">
              <div className="text-[9px] uppercase tracking-[0.18em] opacity-40 leading-none mb-1 flex items-center justify-end gap-[2px]">
                {/* Tiny strip of palette colors as a visual hint that this
                    counter tracks ANY non-background color, not just black. */}
                <span
                  className="inline-flex h-[7px] mr-1 rounded-[1px] overflow-hidden"
                  aria-hidden="true"
                >
                  {[3, 5, 7, 9].map((i) => (
                    <span
                      key={i}
                      className="w-[3px] h-full inline-block"
                      style={{ background: PALETTE[i] }}
                    />
                  ))}
                </span>
                <span>painted</span>
              </div>
              <div className="text-sm tabular-nums leading-none">
                {paintedCount.toLocaleString()}
                {totalCells <= 10000 && totalCells > 1 && (
                  <span className="text-[10px] opacity-40 ml-1">
                    /{totalCells.toLocaleString()}
                  </span>
                )}
              </div>
            </div>

            {/* Ants (hidden on narrow screens) */}
            <div className="ff-mono text-right hidden min-[480px]:block">
              <div className="text-[9px] uppercase tracking-[0.18em] opacity-40 leading-none mb-1">
                ants
              </div>
              <div className="text-sm tabular-nums leading-none flex items-baseline gap-1 justify-end">
                <span>{antStats.total}</span>
                {antStats.regular > 0 && antStats.inverse > 0 && (
                  <span className="text-[10px] opacity-50">
                    <span style={{ color: COLOR_ANT_REGULAR }}>
                      {antStats.regular}
                    </span>
                    <span className="opacity-40">/</span>
                    <span style={{ color: COLOR_ANT_INVERSE }}>
                      {antStats.inverse}
                    </span>
                  </span>
                )}
              </div>
            </div>

            {/* Steps */}
            <div className="ff-mono text-right hidden min-[360px]:block">
              <div className="text-[9px] uppercase tracking-[0.18em] opacity-40 leading-none mb-1">
                steps
              </div>
              <div className="text-sm tabular-nums leading-none">
                {stepCount.toLocaleString()}
              </div>
            </div>

            <button
              onClick={() => setShowInfo(true)}
              className="p-2 -mr-2 opacity-60 hover:opacity-100 transition-opacity"
              aria-label="About"
            >
              <Info size={18} strokeWidth={1.5} />
            </button>
          </div>
        </header>

        {/* Body: canvas + (on large screens) always-visible rules sidebar */}
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 relative overflow-hidden">
          <canvas
            ref={canvasRef}
            className="app-canvas w-full h-full block"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          />

          {/* Top-left: ant spawners + zoom readout */}
          <div className="absolute left-3 top-3 flex flex-col gap-2 items-start">
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => addAnt("regular")}
                className="spawn-btn h-10 w-10 flex items-center justify-center rounded-full"
                style={{
                  background: COLOR_ANT_REGULAR,
                  color: COLOR_BG,
                  boxShadow:
                    "0 2px 8px rgba(0,0,0,0.35), inset 0 0 0 2px rgba(0,0,0,0.1)",
                }}
                aria-label="Add regular ant"
                title="Add a regular ant at the center of the view"
              >
                <Plus size={18} strokeWidth={2.75} />
              </button>
              <button
                onClick={() => addAnt("inverse")}
                className="spawn-btn h-10 w-10 flex items-center justify-center rounded-full"
                style={{
                  background: COLOR_ANT_INVERSE,
                  color: COLOR_BG,
                  boxShadow:
                    "0 2px 8px rgba(0,0,0,0.35), inset 0 0 0 2px rgba(0,0,0,0.1)",
                }}
                aria-label="Add inverse ant"
                title="Add an inverse ant at the center of the view"
              >
                <Plus size={18} strokeWidth={2.75} />
              </button>
            </div>
            <div className="ff-mono text-[10px] uppercase tracking-[0.18em] opacity-55 bg-[#120f0c]/70 backdrop-blur px-2 py-1 rounded-sm">
              {zoomPct}%
            </div>
          </div>

          {/* Top-right: zoom + fit */}
          <div className="absolute right-3 top-3 flex flex-col gap-1.5">
            <button
              onClick={() => zoomAt(1.4)}
              className="h-10 w-10 flex items-center justify-center rounded-full bg-[#120f0c]/85 backdrop-blur border border-white/10 hover:bg-[#120f0c] transition"
              aria-label="Zoom in"
            >
              <Plus size={16} strokeWidth={1.75} />
            </button>
            <button
              onClick={() => zoomAt(1 / 1.4)}
              className="h-10 w-10 flex items-center justify-center rounded-full bg-[#120f0c]/85 backdrop-blur border border-white/10 hover:bg-[#120f0c] transition"
              aria-label="Zoom out"
            >
              <Minus size={16} strokeWidth={1.75} />
            </button>
            <button
              onClick={() => {
                fitToGrid();
                draw();
              }}
              className="h-10 w-10 flex items-center justify-center rounded-full bg-[#120f0c]/85 backdrop-blur border border-white/10 hover:bg-[#120f0c] transition"
              aria-label="Fit grid to view"
              title="Fit grid to view"
            >
              <Crosshair size={15} strokeWidth={1.75} />
            </button>
          </div>

          {/* Bottom-left: grid dims */}
          <div className="absolute left-3 bottom-3 ff-mono text-[10px] uppercase tracking-[0.18em] opacity-40">
            {gridSize} × {gridSize}
            {torus && <span className="ml-2 opacity-70">· torus</span>}
          </div>

          {/* Onboarding hint */}
          {!hasStarted && stepCount === 0 && !showInfo && !noAnts && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none px-3 max-w-[92vw]">
              <div
                className="ff-mono text-[10.5px] tracking-wide text-center px-3.5 py-2 rounded-sm border leading-relaxed"
                style={{
                  background: "rgba(18,15,12,0.92)",
                  borderColor: "rgba(245,235,215,0.15)",
                  color: "rgba(245,235,215,0.72)",
                }}
              >
                <div>tap cells to paint · drag ants to position</div>
                <div className="opacity-70 mt-0.5">
                  resize grid in header ·{" "}
                  <span style={{ color: COLOR_ANT_REGULAR }}>＋</span> add ants
                </div>
              </div>
            </div>
          )}

          {showCounts && scaleDisplay < COUNT_MIN_SCALE && hasStarted && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none px-3">
              <div
                className="ff-mono text-[10px] uppercase tracking-[0.18em] px-2.5 py-1 rounded-sm"
                style={{
                  background: "rgba(18,15,12,0.8)",
                  color: "rgba(245,235,215,0.55)",
                }}
              >
                zoom in to read counts
              </div>
            </div>
          )}

          {noAnts && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none px-3">
              <div
                className="ff-mono text-[11px] uppercase tracking-[0.2em] font-semibold px-3.5 py-2 rounded-sm"
                style={{ background: COLOR_ANT_REGULAR, color: COLOR_INK }}
              >
                no ants · add one to continue
              </div>
            </div>
          )}

          {/* Cycle detection badge — pinned top-center, stays visible until
              clear/reset/resize/torus-toggle. Stacks below the no-ants
              banner on the rare chance both apply. */}
          {cycleInfo !== null && (
            <div
              className={`absolute left-1/2 -translate-x-1/2 pointer-events-none px-3 ${
                noAnts ? "top-16" : "top-4"
              }`}
            >
              <div
                className="flex items-stretch rounded-sm overflow-hidden shadow-lg"
                style={{
                  boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
                  border: "1px solid rgba(26,23,20,0.15)",
                }}
              >
                {/* Label rail */}
                <div
                  className="flex items-center gap-1.5 px-2.5 ff-mono text-[10px] uppercase tracking-[0.2em] font-semibold"
                  style={{
                    background: COLOR_ANT_INVERSE,
                    color: COLOR_TEXT,
                  }}
                >
                  <Repeat size={12} strokeWidth={2.25} />
                  <span>cycle</span>
                </div>
                {/* Length + detail */}
                <div
                  className="px-3 py-1.5 flex flex-col items-start justify-center"
                  style={{ background: COLOR_BG, color: COLOR_INK }}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="ff-display text-[17px] leading-none tabular-nums font-medium">
                      {cycleInfo.length.toLocaleString()}
                    </span>
                    <span className="ff-mono text-[9px] uppercase tracking-[0.15em] opacity-55 leading-none">
                      {cycleInfo.length === 1 ? "step" : "steps"}
                    </span>
                  </div>
                  <div className="ff-mono text-[9.5px] tracking-wide opacity-55 mt-0.5 tabular-nums">
                    repeats @ step{" "}
                    {cycleInfo.firstSeenAtStep.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>

          {/* Always-visible rules sidebar on large screens. Below the lg
              breakpoint, the rules panel is reached via the header button
              and rendered as a modal (further down). The same JSX body
              (`rulesPanelBody`) is rendered in both places — state lives
              in the parent component, so edits flow either way. */}
          <aside
            className="hidden lg:flex flex-col w-96 flex-shrink-0 border-l border-white/10 overflow-y-auto"
            style={{ background: COLOR_BG, color: COLOR_INK }}
          >
            {rulesPanelBody}
          </aside>
        </div>

        {/* Footer controls */}
        <footer
          className="border-t border-white/10 px-3 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] flex-shrink-0"
          style={{ background: COLOR_INK }}
        >
          <div className="flex items-stretch gap-2 max-w-3xl mx-auto">
            <button
              onClick={() => {
                // The Play button is the most reliable "user gesture"
                // moment to wake the AudioContext for the audio feature.
                synthRef.current?.resume();
                setRunning((r) => !r);
              }}
              disabled={noAnts}
              className="h-12 w-14 flex items-center justify-center rounded-sm font-semibold transition disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: noAnts
                  ? "rgba(255,255,255,0.06)"
                  : COLOR_ANT_REGULAR,
                color: COLOR_INK,
              }}
              aria-label={running ? "Pause" : "Play"}
            >
              {running ? (
                <Pause size={20} strokeWidth={2} fill={COLOR_INK} />
              ) : (
                <Play
                  size={20}
                  strokeWidth={2}
                  fill={COLOR_INK}
                  className="ml-0.5"
                />
              )}
            </button>

            <button
              onClick={() => {
                synthRef.current?.resume();
                stepOnce();
              }}
              disabled={running || noAnts}
              className="h-12 w-11 flex items-center justify-center rounded-sm border border-white/15 hover:bg-white/5 disabled:opacity-25 transition"
              aria-label="Step once"
            >
              <SkipForward size={17} strokeWidth={1.75} />
            </button>

            <button
              onClick={reset}
              disabled={!hasSnapshot}
              className="h-12 w-11 flex items-center justify-center rounded-sm border border-white/15 hover:bg-white/5 disabled:opacity-25 disabled:cursor-not-allowed transition"
              aria-label="Reset to start of run"
              title="Reset — rewind to the start of this run"
            >
              <RotateCcw size={16} strokeWidth={1.75} />
            </button>

            <button
              onClick={clear}
              className="h-12 w-11 flex items-center justify-center rounded-sm border border-white/15 hover:bg-white/5 transition"
              aria-label="Clear to default state"
              title="Clear — blank board with a single ant facing up"
            >
              <Eraser size={16} strokeWidth={1.75} />
            </button>

            <div className="flex-1 flex flex-col justify-center gap-1.5 pl-2 min-w-0">
              <div className="flex items-baseline justify-between">
                <span className="ff-mono text-[9px] uppercase tracking-[0.18em] opacity-40">
                  speed
                </span>
                <span className="ff-mono text-[11px] tabular-nums opacity-70">
                  {SPEED_LABELS[speedIdx]}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={SPEEDS.length - 1}
                step={1}
                value={speedIdx}
                onChange={(e) => setSpeedIdx(parseInt(e.target.value, 10))}
                className="ant-range w-full"
              />
            </div>
          </div>
        </footer>

        {/* Info modal */}
        {showInfo && (
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 z-50"
            onClick={() => setShowInfo(false)}
          >
            <div
              className="w-full sm:max-w-xl relative border-t sm:border max-h-[90vh] overflow-y-auto"
              style={{
                background: COLOR_BG,
                color: COLOR_INK,
                borderColor: "rgba(26,23,20,0.12)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowInfo(false)}
                className="absolute top-3 right-3 p-2 hover:bg-black/5 rounded-sm z-10"
                aria-label="Close"
              >
                <X size={18} strokeWidth={1.5} />
              </button>
              <div className="p-6 sm:p-7 pb-[max(env(safe-area-inset-bottom),1.75rem)]">
                
                <h1 className="ff-display text-3xl leading-none mb-1">Oh you're gonna love this one.</h1>
                <p className="text-[13px] leading-relaxed mb-3">
                  Langton’s Ant is an example of a cellular automota, Let’s ignore the mathematical definition for now, and think of it as a bunch of cells, each in one of several states, which transition due to some rules. The prototypical example is Conway’s Game of Life. 
                </p>
                <p className="text-[13px] leading-relaxed mb-3">I’ve been messing around with GoL since 6th grade, but I only recently came across Langton’s Ant. It’s very much the ugly cousin of GoL, but the rules are just as simple and dynamics are pretty cool. </p>
                <p className="text-[13px] leading-relaxed mb-3">An ant sits on the grid of cells. Every cell is either white or black. If the cell is white, the ant rotates 90 degrees clockwise and moves forward 1. If the cell is black, it rotates 90 degrees counter clockwise and moves forward 1. Either way, the cell it just left flips color. </p>
                <p className="text-[13px] leading-relaxed mb-3">Of course, we can extend these rules to our heart’s content. Usually this involves increasing the number of possible cell states, as well as possible ant transition rules. Rather than stop there, I decided to go full Mad Max</p>
                <p className="text-[13px] leading-relaxed mb-3">Introducing...</p>
                <h2 className="ff-display italic text-3xl leading-none mb-1">
                  Ants on a Piano
                </h2>
                <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-5">
                  Brought to you by J Nicks Productions
                </p>

                <div className="space-y-4 text-[14px] leading-relaxed">
                  <p>
                    An ant walks on a grid where each cell is one of{" "}
                    <b>{NUM_COLORS} colors</b>. At every step:
                  </p>
                  <ul className="space-y-2 text-[13px]">
                    <li className="flex gap-3 items-start">
                      <span className="font-semibold opacity-60 ff-mono text-[11px] mt-0.5">
                        1.
                      </span>
                      <span>
                        The ant reads the color under it, then turns
                        according to the <b>rule for that color</b>.
                      </span>
                    </li>
                    <li className="flex gap-3 items-start">
                      <span className="font-semibold opacity-60 ff-mono text-[11px] mt-0.5">
                        2.
                      </span>
                      <span>
                        The cell <b>becomes the destination color</b> set
                        for it &mdash; by default the next color in the
                        cycle, but any color-to-color mapping is allowed.
                      </span>
                    </li>
                    <li className="flex gap-3 items-start">
                      <span className="font-semibold opacity-60 ff-mono text-[11px] mt-0.5">
                        3.
                      </span>
                      <span>The ant steps one square forward.</span>
                    </li>
                  </ul>

                  {/* Compact palette swatch — index on top, note below */}
                  <div className="pt-1">
                    <div className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-1.5">
                      Palette · notes
                    </div>
                    <div className="flex items-stretch rounded-sm overflow-hidden border border-[#1a1714]/12">
                      {PALETTE.map((c, i) => (
                        <div
                          key={i}
                          className="flex-1 flex flex-col items-center justify-center ff-mono leading-none py-1.5"
                          style={{
                            background: c,
                            color: PALETTE_TEXT_LIGHT[i]
                              ? COLOR_TEXT
                              : COLOR_INK,
                          }}
                          title={`Color ${i} → note ${midiToName(notes[i])} (${midiToFreq(notes[i]).toFixed(1)} Hz)`}
                        >
                          <span className="text-[9px] opacity-60 tabular-nums">
                            {i}
                          </span>
                          <span className="text-[10px] mt-0.5 tabular-nums font-medium">
                            {midiToName(notes[i])}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <p className="opacity-75 text-[13px] pt-1">
                    The classical 2-color Langton&rsquo;s ant is a turmite
                    with rule <span className="ff-mono">RL</span>. With more
                    colors and different rules, ants produce a wild variety
                    of patterns &mdash; spirals, highways, fractals, or
                    chaos. Tap the palette button in the header to edit the
                    rules and the note assigned to each color.
                  </p>
                </div>

                <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
                  <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
                    Grid size
                  </p>
                  <p className="text-[13px] leading-relaxed">
                    The board is <b>{gridSize}&thinsp;×&thinsp;{gridSize}</b>{" "}
                    right now &mdash; the stepper in the header changes it to
                    any <span className="ff-mono"> N&thinsp;×&thinsp;N </span>
                    from {MIN_GRID} up to {MAX_GRID.toLocaleString()}. Resizing
                    starts the board over. On small grids,{" "}
                    <b>torus&nbsp;wrap</b> is on by default so the ant has
                    somewhere to go &mdash; with wrap off, a 3×3 ant falls off
                    the edge after a single step.
                  </p>
                </div>

                <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
                  <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
                    Ants
                  </p>
                  <div className="space-y-3 text-[13px] leading-relaxed">
                    <div className="flex gap-3 items-start">
                      <span
                        className="w-5 h-5 mt-0.5 flex-shrink-0 rounded-[3px]"
                        style={{ background: COLOR_ANT_REGULAR }}
                      />
                      <span>
                        <b>Regular ant.</b> Follows the rule for the color
                        it&rsquo;s standing on, as set in the rules editor.
                      </span>
                    </div>
                    <div className="flex gap-3 items-start">
                      <span
                        className="w-5 h-5 mt-0.5 flex-shrink-0 rounded-[3px]"
                        style={{ background: COLOR_ANT_INVERSE }}
                      />
                      <span>
                        <b>Inverse ant.</b> Same rules, but L and R are
                        swapped &mdash; a mirror twin.
                      </span>
                    </div>
                    <p className="text-[12.5px] opacity-75 pt-1">
                      All ants step at the same time. If multiple ants leave
                      the same square in one tick, the cell&rsquo;s
                      transition is applied once per ant &mdash; so two ants
                      means two hops along the destination map.
                    </p>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
                  <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
                    Stats
                  </p>
                  <dl className="text-[12.5px] grid grid-cols-[auto,1fr] gap-x-3 gap-y-2 items-baseline">
                    <dt className="ff-mono uppercase text-[10px] tracking-[0.18em] opacity-55">
                      painted
                    </dt>
                    <dd>
                      Cells whose color is anything other than 0 (the cream
                      background). Updates live as cells advance; shows{" "}
                      <span className="ff-mono">/total</span> when the grid
                      is small enough.
                    </dd>
                    <dt className="ff-mono uppercase text-[10px] tracking-[0.18em] opacity-55">
                      ants
                    </dt>
                    <dd>Total, split by regular / inverse when both are present.</dd>
                    <dt className="ff-mono uppercase text-[10px] tracking-[0.18em] opacity-55">
                      steps
                    </dt>
                    <dd>Simulation ticks since the last reset.</dd>
                  </dl>
                </div>

                <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
                  <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
                    Sound
                  </p>
                  <p className="text-[13px] leading-relaxed">
                    Each color maps to a musical note. The default is the{" "}
                    <b>chromatic scale</b> ascending by one half-step per
                    color (C4 → B4), but you can change any color&rsquo;s
                    note in the rules panel. Whenever a cell changes color,
                    the note for the <b>new color</b> plays.
                  </p>
                  <p className="text-[12.5px] opacity-75 leading-relaxed mt-2">
                    With the default chromatic mapping, close-together flips
                    sound clustered and dissonant. Remap a few rows to taste
                    — a major triad, a pentatonic, a drone — to get whatever
                    texture you want. The slowest speed (½ step/sec) lets
                    each note ring out; the fastest (600/sec) overlaps notes
                    into a wash. Use the speaker toggle in the header to
                    mute.
                  </p>
                </div>

                <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
                  <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
                    Cycle detection
                  </p>
                  <p className="text-[13px] leading-relaxed">
                    On grids up to{" "}
                    <span className="ff-mono">
                      {MAX_CYCLE_GRID}&thinsp;×&thinsp;{MAX_CYCLE_GRID}
                    </span>
                    , the full state of the board and ants is hashed after
                    every step. When a state recurs, a badge appears at the
                    top showing the <b>cycle length</b> (how many steps it
                    takes to return to the same configuration) and the step
                    it first appeared at. The badge stays until you clear,
                    reset, resize, or toggle wrap.
                  </p>
                  <p className="text-[12.5px] opacity-75 leading-relaxed mt-2">
                    Most cycles happen on small torus boards. On a large
                    grid with wrap off, the ant heads for the highway and
                    never repeats &mdash; detection is skipped there.
                  </p>
                </div>

                <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
                  <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
                    Options
                  </p>
                  <dl className="text-[12.5px] grid grid-cols-[auto,1fr] gap-x-3 gap-y-2.5 items-start">
                    <dt className="flex items-center justify-center w-6 h-6 rounded-sm border border-[#1a1714]/25">
                      <Hash size={13} strokeWidth={2} />
                    </dt>
                    <dd>
                      <b>Visit counts.</b> Overlay each square with how many
                      ant-steps have originated from it.
                    </dd>
                    <dt className="flex items-center justify-center w-6 h-6 rounded-sm border border-[#1a1714]/25">
                      <InfinityIcon size={14} strokeWidth={2} />
                    </dt>
                    <dd>
                      <b>Torus topology.</b> Wraps the board at every edge, so
                      ants walk on a donut and can&rsquo;t fall off.
                    </dd>
                    <dt className="flex items-center justify-center w-6 h-6 rounded-sm border border-[#1a1714]/25">
                      <Volume2 size={13} strokeWidth={2} />
                    </dt>
                    <dd>
                      <b>Sound.</b> Plays a soft note for every color change
                      (see the Sound section above).
                    </dd>
                  </dl>
                </div>

                <div className="mt-6 pt-4 border-t border-[#1a1714]/10">
                  <p className="ff-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mb-3">
                    Controls
                  </p>
                  <dl className="ff-mono text-[11.5px] grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5">
                    <dt className="opacity-50">tap cell</dt>
                    <dd>cycle its color forward</dd>
                    <dt className="opacity-50">drag ant</dt>
                    <dd>reposition it (while paused)</dd>
                    <dt className="opacity-50">long-press ant</dt>
                    <dd>remove it (while paused)</dd>
                    <dt className="opacity-50">＋ buttons</dt>
                    <dd>spawn an ant at the view center</dd>
                    <dt className="opacity-50">drag empty</dt>
                    <dd>pan the board</dd>
                    <dt className="opacity-50">pinch / scroll</dt>
                    <dd>zoom</dd>
                    <dt className="opacity-50 pt-2">reset</dt>
                    <dd className="pt-2">
                      rewind to the start of this run
                    </dd>
                    <dt className="opacity-50">clear</dt>
                    <dd>blank board, one ant facing up</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Rules editor modal — small screens only. On lg+ the sidebar
            handles this. We still let `showRules` stay true if the user
            resizes from small to large; the modal just hides itself. */}
        {showRules && (
          <div
            className="lg:hidden absolute inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 z-50"
            onClick={() => setShowRules(false)}
          >
            <div
              className="w-full sm:max-w-md relative border-t sm:border max-h-[90vh] overflow-y-auto"
              style={{
                background: COLOR_BG,
                color: COLOR_INK,
                borderColor: "rgba(26,23,20,0.12)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowRules(false)}
                className="absolute top-3 right-3 p-2 hover:bg-black/5 rounded-sm z-10"
                aria-label="Close rules editor"
              >
                <X size={18} strokeWidth={1.5} />
              </button>
              {rulesPanelBody}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// --- Header toggle button ------------------------------------------------
type ToggleButtonProps = {
  active: boolean;
  onClick: () => void;
  label: string;
  activeLabel: string;
  children: React.ReactNode;
};

function ToggleButton({
  active,
  onClick,
  label,
  activeLabel,
  children,
}: ToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`h-9 pl-2 pr-2 sm:pr-2.5 flex items-center gap-1.5 rounded-sm border transition select-none ${
        active
          ? "border-transparent"
          : "border-white/15 opacity-60 hover:opacity-100 hover:bg-white/5"
      }`}
      style={
        active
          ? { background: COLOR_ANT_REGULAR, color: COLOR_INK }
          : { background: "transparent", color: COLOR_TEXT }
      }
    >
      {children}
      <span
        className={`ff-mono text-[10px] uppercase tracking-[0.16em] hidden sm:inline ${
          active ? "font-semibold" : ""
        }`}
      >
        {activeLabel}
      </span>
    </button>
  );
}