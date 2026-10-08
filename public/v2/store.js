// Tiny observable store: get(), set(patch|fn), subscribe(fn). UI-wide ephemeral state only. Pure (no DOM).
export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? next(state) : { ...state, ...next };
      for (const fn of subs) fn(state);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
