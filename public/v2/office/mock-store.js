// In-memory stand-in for the office layout API, contract 2.0 + the 2.1 proposal
// (design/office/api-proposal.md §5). Used by the demo and tests. Pure; no DOM.
//   GET /api/v2/office/layout                  → get()                 data: LayoutVM
//   GET /api/v2/office/layout/revisions/:rev   → getRevision(rev)      data: LayoutRevisionVM   (proposed)
//   PUT /api/v2/office/layout                  → put({expectedRevision, data})   data: CommandResult (revision, vm)
// Errors are thrown as { status, error: ApiError.error } (api.md §2.2).
import { resolveTheme } from './theme.js';

const clone = (o) => structuredClone(o);
export const KEEP_REVISIONS = 20;
const Owner = { id: 'per_alex00000000000', kind: 'human', name: 'Owner', avatarUrl: null, state: null };   // PersonChip

/** Next theme switch (ms) for an auto theme, scanning minute by minute over 24 h (mock precision). */
function nextChangeAt(theme, now, tz) {
  if (theme.mode !== 'auto') return null;
  const cur = resolveTheme(theme, new Date(now), tz);
  const start = now - (now % 60_000) + 60_000;
  for (let t = start; t < now + 86_400_000 + 60_000; t += 60_000) if (resolveTheme(theme, new Date(t), tz) !== cur) return t;
  return null;
}

/**
 * @param {object} opts
 * @param {object} opts.data          the active layout (OfficeLayoutDataV1)
 * @param {object} opts.defaultData   the shipped default (design/office/layout.example.json)
 * @param {object} [opts.manifest]
 * @param {(data) => {code:string, message:string}[]} [opts.validate]  the shared semantic validator (layout-rules.js)
 * @param {{id, role, name, lastSeenAt}[]} [opts.agentsSeen]
 * @param {number} [opts.latencyMs]
 * @param {() => number} [opts.now]
 */
export function createMockLayoutStore({ data, defaultData, manifest = null, validate = null, agentsSeen = [], latencyMs = 0, now = () => Date.now(), timeZone = undefined }) {
  // updatedBy is a PersonChip (layout-vm.json); the seeded default has no human author (null).
  let revisions = [{ revision: 1, data: clone(data), updatedAt: now(), updatedBy: { kind: 'system', name: 'Système' } }];
  const wait = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  const head = () => revisions[revisions.length - 1];
  const meta = (r) => ({ id: String(r.revision), revision: r.revision, updatedAt: r.updatedAt, updatedBy: r.updatedBy });

  /** LayoutVM (api.md §3.10, plus the proposed default / revisions / agentsSeen). */
  function vm() {
    const h = head();
    const t = h.data.theme ?? { mode: 'auto' };
    return {
      layout: { id: 'lay_main00000000000', name: 'Bureau principal', revision: h.revision, updatedAt: h.updatedAt, updatedBy: h.updatedBy, data: clone(h.data) },
      manifest,
      theme: { resolved: resolveTheme(t.mode === 'fixed' ? t.fixed : { ...t, mode: 'auto' }, new Date(now()), timeZone), mode: t.mode ?? 'auto', nextChangeAt: nextChangeAt(t, now(), timeZone), season: t.season ?? null },
      default: { data: clone(defaultData) },
      revisions: revisions.map(meta).reverse(),
      agentsSeen: agentsSeen.filter((a) => now() - a.lastSeenAt < 30 * 86_400_000),
    };
  }

  function commit(next, by) {
    const r = { revision: head().revision + 1, data: clone(next), updatedAt: now(), updatedBy: by };
    revisions.push(r);
    if (revisions.length > KEEP_REVISIONS) revisions = revisions.slice(-KEEP_REVISIONS);
    return r;
  }

  return {
    async get() { await wait(); return vm(); },
    /** Synchronous LayoutVM (for mock servers whose topic builders are synchronous). */
    vmNow: () => vm(),
    async getRevision(rev) {
      await wait();
      const r = revisions.find((x) => x.revision === rev);
      if (!r) throw { status: 404, error: { code: 'not_found', message: 'Version introuvable' } };
      return { ...meta(r), data: clone(r.data) };
    },
    async put({ expectedRevision, data: next }) {
      await wait();
      if (expectedRevision !== head().revision) {
        throw { status: 409, error: { code: 'conflict', message: 'Le bureau a été modifié ailleurs.', current: { revision: head().revision, vm: vm() } } };
      }
      const errors = validate ? validate(next) : [];
      if (errors.length) throw { status: 400, error: { code: 'validation_failed', message: errors[0].message, details: errors.map((e) => ({ issue: e.code, field: e.uid ? `items.${e.uid}` : e.agentId ? `agents.${e.agentId}` : undefined })) } };
      const r = commit(next, Owner);
      return { ok: true, result: null, revision: r.revision, vm: vm() };
    },
    /** Demo: someone else saves meanwhile (another tab or device). */
    externalEdit(mutate) {
      const next = clone(head().data);
      mutate?.(next);
      return meta(commit(next, { ...Owner, name: 'Owner (autre appareil)' }));
    },
    get revision() { return head().revision; },
  };
}

