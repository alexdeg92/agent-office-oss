// Agent state → pose, marker and micro-motion (design/office/README.md §4.2). Pure data.

export const STATES = ['idle', 'thinking', 'working', 'researching', 'writing', 'calling', 'waiting', 'error', 'offline'];

/** French labels; the live app takes them from MetaVM.labels['agentState.*'] and passes them in. */
export const STATE_LABELS = {
  idle: 'Inactif',
  thinking: 'Réfléchit',
  working: 'Travaille',
  researching: 'Recherche',
  writing: 'Rédige',
  calling: "Appel d'outil",
  waiting: 'En attente',
  error: 'Erreur',
  offline: 'Hors ligne',
};

/**
 * pose: image key in the character's pose set.
 * marker: fx marker kind (null = none).
 * monitor: 'on' | 'off' | 'error' for the station monitor.
 * motion: CSS micro-motion name (office.css), suppressed under reduced motion.
 */
export const STATE_VIEW = {
  idle: { pose: 'idle', marker: null, monitor: 'off', motion: 'breathe' },
  thinking: { pose: 'thinking', marker: 'thought', monitor: 'on', motion: null },
  working: { pose: 'working', marker: null, monitor: 'on', motion: 'type' },
  researching: { pose: 'working', marker: 'reading', monitor: 'on', motion: 'type' },
  writing: { pose: 'working', marker: 'pen', monitor: 'on', motion: 'type-fast' },
  calling: { pose: 'talking', marker: 'phone', monitor: 'on', motion: null },
  waiting: { pose: 'idle', marker: 'question', monitor: 'on', motion: null },
  error: { pose: 'alert', marker: 'alert', monitor: 'error', motion: 'shake' },
  offline: { pose: 'sleeping', marker: 'zz', monitor: 'off', motion: 'breathe-slow' },
};

export function viewFor(state) {
  return STATE_VIEW[state] ?? STATE_VIEW.idle;
}

/** One-shot cues (SSE 'cue' frames). Durations from README §4.2. */
export const CUES = {
  celebrating: { pose: 'celebrating', ms: 1600, motion: 'hop' },
  talking: { pose: 'talking', ms: 1500, motion: null },
  delegating: { pose: 'talking', ms: 1500, motion: null },
};

export const WALK_TILES_PER_S = 1.5;
export const CROSSFADE_MS = 120;
export const LOUNGE_AFTER_MS = 10 * 60 * 1000;

/**
 * Seated at the desk, back to the camera, facing the monitor (BRIEF decisions log, facing and desk
 * behaviour). Used when the look has the Batch 6 seated poses (assets.seatModeFor → 'desk').
 * turn: the state swivels the chair toward the camera (pose is then a *-sw seated pose).
 */
export const SEATED_VIEW = {
  idle: { pose: 'seated-ne' },
  thinking: { pose: 'thinking-ne' },
  working: { pose: 'working-ne' },
  researching: { pose: 'life-readseat-ne' },
  writing: { pose: 'working-ne' },
  calling: { pose: 'life-phone-ne' },
  waiting: { pose: 'seated-ne' },
  error: { pose: 'seated-alert-sw', turn: true },
  offline: { pose: 'sleeping-ne' },
};

/** Cue poses while seated: every cue swivels toward the camera. */
export const SEATED_CUES = { celebrating: 'seated-celebrating-sw', talking: 'seated-talking-sw', delegating: 'seated-talking-sw' };

/** Sofa (lounge with sofa-sit-sw). */
export const SOFA_VIEW = { offline: 'sofa-sleep-sw', default: 'sofa-sit-sw' };

export const SWIVEL_MS = 140;            // the intermediate seated pose during a turn
export const SELECT_WAVE_MS = 1800;      // selection: swivel + short wave, then back to work
export const IDLE_SWIVEL_EVERY_MS = [25_000, 50_000];
export const IDLE_SWIVEL_HOLD_MS = 3_500;
