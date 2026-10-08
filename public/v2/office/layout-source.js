// The office's LayoutVM source and layout API, shared by the Bureau (page.js) and the Boutique (boutique.js).
import { useEffect, useState } from '../lib.js';
import { services } from '../services.js';
import * as api from '../api.js';
import { config } from '../config.js';
import * as fmtTz from '../fmt.js';
import { resolveTheme } from './theme.js';

// Seam for the standalone harness (bureau-dev.html): services.officeAssetBase.
const assetBase = () => services.officeAssetBase ?? config.assetBase;

/**
 * Until the server stores layouts (S14b: GET /api/v2/office/layout), the office is drawn from the shipped
 * default and manifest (<assetBase>office/*.example.json, the files the server's OfficeVM resolves against),
 * read-only: no editor, no theme writes. Used only when the layout topic fails.
 */
export function shippedLayoutVM(manifest, data, now = Date.now(), tz = undefined) {
  return { readOnly: true, manifest, layout: { id: 'default', name: null, revision: 0, updatedAt: null, updatedBy: null, data },
    default: { data }, revisions: [], agentsSeen: [],
    theme: { resolved: resolveTheme(data.theme, new Date(now), tz), mode: data.theme.mode, nextChangeAt: null, season: data.theme.season ?? null } };
}
/**
 * The LayoutVM: one GET first; the `layout` topic is subscribed only once that route answers. A topic the server
 * doesn't know makes the stream's batched POST /topics fail (400 unknown-topic), which would also stop the `office`
 * topic (explorer-qa-01 Q01-01). Route missing (404, before S14b) → the shipped layout, read-only.
 */
export function useLayout() {
  const [mode, setMode] = useState('probe');            // 'probe' | 'live' | 'shipped'
  const [v, set] = useState({ data: undefined, loading: true, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (mode !== 'probe') return undefined;
    let live = true;
    officeApi().get().then(() => live && setMode('live'), (err) => {
      if (!live) return;
      if (err && (err.code === 'not_found' || err.status === 404)) setMode('shipped');
      else set({ data: undefined, loading: false, error: err });
    });
    return () => { live = false; };
  }, [mode, n]);
  useEffect(() => (mode === 'live' ? services.stream.subscribe('layout', '/api/v2/office/layout', set) : undefined), [mode]);
  useEffect(() => {
    if (mode !== 'shipped') return undefined;
    let live = true;
    const get = (name) => fetch(`${assetBase()}office/${name}.example.json`).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
    Promise.all([get('manifest'), get('layout')]).then(([m, d]) => live && set({ data: shippedLayoutVM(m, d, Date.now(), fmtTz.timeZone()), loading: false, error: null }),
      (error) => live && set({ data: undefined, loading: false, error }));
    return () => { live = false; };
  }, [mode]);
  const retry = () => { if (mode === 'live') services.stream.retry('layout'); else { set({ data: undefined, loading: true, error: null }); setN((x) => x + 1); if (mode === 'shipped') setMode('probe'); } };
  return { ...v, retry };
}

/** Layout API (api.md §5.5 + proposal §4–5): what the editor and the theme toggle write through. */
const httpOfficeApi = {
  get: () => api.get('/api/v2/office/layout', { quiet: true }).then((r) => r.data),
  getRevision: (rev) => api.get(`/api/v2/office/layout/revisions/${rev}`, { quiet: true }).then((r) => r.data),
  put: (body) => api.put('/api/v2/office/layout', body, { quiet: true }).then((r) => r.data),
  putTheme: (body) => api.put('/api/v2/office/layout/theme', body, { quiet: true }).then((r) => r.data),
};
export const officeApi = () => services.officeApi ?? httpOfficeApi;

