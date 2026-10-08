import { useState, useEffect } from './lib.js';
import { services } from './services.js';
import { runtimeCan as can } from './vocab.js';

/** Subscribes to a store created with createStore(); returns its current state. */
export function useStore(store) {
  const [s, set] = useState(store.get());
  useEffect(() => { set(store.get()); return store.subscribe(set); }, [store]);
  return s;
}

/** Live view model for an SSE topic (api.md §4): { data, rev, loading, error, resyncing, retry }. */
export function useTopic(topic, url) {
  const [v, set] = useState({ data: undefined, loading: true, error: null });
  useEffect(() => services.stream.subscribe(topic, url, set), [topic, url]);
  return { ...v, retry: () => services.stream.retry(topic) };
}

/** Re-renders every `ms` (relative times, the clock). */
export function useNow(ms = 30_000) {
  const [now, set] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => set(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

/** One GET without a topic (lists that aren't live yet): { data, loading, error, reload }. */
export function useFetch(url, fetcher) {
  const [v, set] = useState({ data: undefined, loading: true, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    set((x) => ({ ...x, loading: true, error: null }));
    fetcher(url).then((data) => live && set({ data, loading: false, error: null }), (error) => live && set((x) => ({ ...x, loading: false, error })));
    return () => { live = false; };
  }, [url, n]);
  return { ...v, reload: () => setN((x) => x + 1) };
}

/** Whether this instance accepts a class of write (api.md §5.0): 'openclawWrites' (runtime) or 'storeWrites' (Agent Office's
 *  own data). The live stream's capabilities win over meta's; unknown means allowed (the server still decides). */
/** G5 (api-v3.md D1): what the runtime can do ('chat', 'flows.write', …) per the loaded MetaVM (vocab.runtimeCan). */
export const runtimeCan = (path) => can(path, services.meta);
export function useCapability(name) {
  const st = useStore(services.stream.status);
  const caps = st.capabilities || (services.meta && services.meta.capabilities) || {};
  return caps[name] !== false;
}
