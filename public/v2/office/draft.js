// The Boutique's layout draft (office-dev-21): one draft shared by the catalog and placement mode, with the editor's
// undo history, saved in one go through the existing layout write (PUT /office/layout, expectedRevision; a 409 carries
// the current version). No DOM. The page subscribes and re-renders on every change.
import { History, validateLayout } from './editor-model.js';

/**
 * @param {object} vm     the LayoutVM the draft starts from
 * @param {object} index  indexManifest(vm.manifest)
 * @param {{ put: (body) => Promise<object> }} store  the layout API (officeApi())
 */
export function createDraft(vm, index, store) {
  const subs = new Set();
  const st = { vm, history: new History(vm.layout.data), savedAt: 0, saving: false, conflict: null, said: '', seq: 0 };
  const emit = () => { st.seq++; for (const fn of subs) fn(); };
  const say = (text) => { st.said = text || ''; };
  const api = {
    get vm() { return st.vm; },
    get data() { return st.history.current; },
    get dirty() { return st.history.dirty; },
    /** Changes since the saved version, as undo steps (Enregistrer (N)). */
    get count() { return st.history.dirty ? Math.max(1, Math.abs(st.history.i - st.savedAt)) : 0; },
    get canUndo() { return st.history.canUndo; },
    get canRedo() { return st.history.canRedo; },
    get saving() { return st.saving; },
    get conflict() { return st.conflict; },
    get errors() { return validateLayout(st.history.current, index); },
    get announcement() { return st.said; },
    get seq() { return st.seq; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** A new draft document (from catalog.js / agent-looks.js / placement). Returns false when nothing changed. */
    commit(next, announce) { const changed = st.history.push(next); say(announce); emit(); return changed; },
    undo(announce) { if (st.history.canUndo) { st.history.undo(); say(announce); emit(); } },
    redo(announce) { if (st.history.canRedo) { st.history.redo(); say(announce); emit(); } },
    /**
     * Save: the PUT carries a frozen snapshot; edits made while it is pending stay dirty (R7-05). A 409 keeps the
     * draft and exposes `conflict` ({ current }) for the page to offer « Recharger » or « Remplacer ».
     */
    async save({ overwrite = false } = {}) {
      if (st.saving) return { ok: false };
      const submitted = structuredClone(st.history.current);
      st.saving = true; st.conflict = null; emit();
      try {
        const expectedRevision = overwrite && st.lastConflict ? st.lastConflict.revision : st.vm.layout.revision;
        const res = await store.put({ expectedRevision, data: submitted });
        st.vm = res.vm ?? { ...st.vm, layout: { ...st.vm.layout, revision: res.revision, data: submitted } };
        st.history.markSaved(submitted);
        st.savedAt = st.history.i;
        st.saving = false; st.lastConflict = null;
        emit();
        return { ok: true, revision: st.vm.layout.revision };
      } catch (err) {
        st.saving = false;
        const e = err?.error ?? err;
        if (e?.code === 'conflict' && e.current) { st.conflict = e.current; st.lastConflict = e.current; emit(); return { ok: false, conflict: true }; }
        emit();
        return { ok: false, error: e };
      }
    },
    /** After a 409: adopt the server's version (the draft's unsaved changes are dropped; history keeps them for undo). */
    reloadFromConflict() {
      const cur = st.conflict ?? st.lastConflict;
      if (!cur) return;
      st.vm = cur.vm ?? { ...st.vm, layout: { ...st.vm.layout, revision: cur.revision, data: cur.data ?? cur.vm?.layout?.data } };
      const data = st.vm.layout.data;
      st.history.push(data);
      st.history.markSaved(data);
      st.savedAt = st.history.i;
      st.conflict = null; st.lastConflict = null;
      emit();
    },
    dismissConflict() { st.conflict = null; emit(); },
    /** A newer server version arrived while nothing is unsaved: follow it. */
    follow(vm2) {
      if (st.history.dirty || st.saving || !vm2 || vm2.layout.revision === st.vm.layout.revision) return;
      st.vm = vm2;
      st.history.push(vm2.layout.data);
      st.history.markSaved(vm2.layout.data);
      st.savedAt = st.history.i;
      emit();
    },
  };
  return api;
}
