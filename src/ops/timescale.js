'use strict';
/*
 * G10 (test-only): AO_TIME_SCALE compresses the periodic loops (runtime refreshes, config, skills, session groups, host
 * metrics, live pulls, the health sampler, the quarantine flush) so an end-to-end test runs N simulated minutes in
 * N / scale real minutes. Honoured only for the 'test' instance (AO_ENV=test); every other instance runs at scale 1.
 */
function timeScale(env = process.env) {
  if (env.AO_ENV !== 'test') return 1;
  const n = Number(env.AO_TIME_SCALE);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 1;
}
// a loop period, compressed under the test scale (never below 10 ms)
const every = (ms) => Math.max(10, Math.round(ms / timeScale()));

module.exports = { timeScale, every };
