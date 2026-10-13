// The office's LayoutVM source and layout API, shared by the Bureau (page.js) and the Boutique (boutique.js).
import { useEffect, useState } from '../lib.js';
import { services } from '../services.js';
import * as api from '../api.js';
import { config } from '../config.js';
import * as fmtTz from '../fmt.js';
import { resolveTheme } from './theme.js';
import { createOfficeLayoutClient, layoutLocation } from './layout-client.js';

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
export function useLayout(floor = null) {
  const [mode, setMode] = useState('probe');            // 'probe' | 'live' | 'shipped'
  const [v, set] = useState({ data: undefined, loading: true, error: null });
  const [n, setN] = useState(0);
  useEffect(() => { setMode('probe'); set({data:undefined,loading:true,error:null}); }, [floor]);
  useEffect(() => {
    if (mode !== 'probe') return undefined;
    let live = true;
    officeApi(floor).get().then(() => live && setMode('live'), (err) => {
      if (!live) return;
      if (floor == null && err && (err.code === 'not_found' || err.status === 404)) setMode('shipped');
      else set({ data: undefined, loading: false, error: err });
    });
    return () => { live = false; };
  }, [mode, n, floor]);
  useEffect(() => {
    const {topic,url}=layoutLocation(floor);
    return mode === 'live' ? services.stream.subscribe(topic,url,set) : undefined;
  }, [mode, floor]);
  useEffect(() => {
    if (mode !== 'shipped') return undefined;
    let live = true;
    const get = (name) => fetch(`${assetBase()}office/${name}.example.json`).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
    Promise.all([get('manifest'), get('layout')]).then(([m, d]) => live && set({ data: shippedLayoutVM(m, d, Date.now(), fmtTz.timeZone()), loading: false, error: null }),
      (error) => live && set({ data: undefined, loading: false, error }));
    return () => { live = false; };
  }, [mode]);
  const retry = () => { if (mode === 'live') services.stream.retry(layoutLocation(floor).topic); else { set({ data: undefined, loading: true, error: null }); setN((x) => x + 1); if (mode === 'shipped') setMode('probe'); } };
  return { ...v, retry };
}

/** Layout API (api.md §5.5 + proposal §4–5): what the editor and the theme toggle write through. */
export const officeApi = (floor = null) => services.officeApi?.forFloor && floor != null
  ? services.officeApi.forFloor(floor)
  : services.officeApi && (floor == null || floor === '1') ? services.officeApi : createOfficeLayoutClient(api,floor);

