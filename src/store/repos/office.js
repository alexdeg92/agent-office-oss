'use strict';
const { OCCUPANT_ID_MAX, cpLength } = require('../../engine/model/kinds');   // R24-01; R26-01 (code points, as the CHECK)
/*
 * Office layouts (S14b, data-model §12, storage.md "Office"): one active layout, a revision per save, the last 20
 * revisions kept; the occupants-seen inventory (30 days, ≤ 200 served); and the UI preferences (ui_prefs).
 * The default layout is seeded on first use from the shipped file. Validation is the caller's (the shared validator).
 */
const { mintId } = require('../ids');
const { redactChatIdentity } = require('../../security/redact-text');

const KEEP_REVISIONS = 20;
const SEEN_DAYS = 30, SEEN_MAX = 200;
const SYSTEM = { kind: 'system', component: 'engine' };

function createOfficeRepo(db, { now = () => Date.now() } = {}) {
  const active = db.prepare('SELECT * FROM office_layouts WHERE active = 1');
  const insLayout = db.prepare('INSERT INTO office_layouts (id, name, active, revision, data_json, updated_at, updated_by_json) VALUES (?, ?, 1, 1, ?, ?, ?)');
  const upd = db.prepare('UPDATE office_layouts SET revision = ?, data_json = ?, updated_at = ?, updated_by_json = ? WHERE id = ? AND revision = ?');
  const insRev = db.prepare('INSERT INTO office_layout_revisions (layout_id, revision, data_json, saved_at, updated_by_json) VALUES (?, ?, ?, ?, ?)');
  const pruneRev = db.prepare('DELETE FROM office_layout_revisions WHERE layout_id = ? AND revision <= ?');
  const revs = db.prepare('SELECT revision, saved_at, updated_by_json FROM office_layout_revisions WHERE layout_id = ? ORDER BY revision DESC LIMIT ?');
  const rev = db.prepare('SELECT revision, data_json, saved_at, updated_by_json FROM office_layout_revisions WHERE layout_id = ? AND revision = ?');
  const seenUp = db.prepare(`INSERT INTO office_agents_seen (occupant_id, role, name, last_seen_at, automatic_look_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (occupant_id) DO UPDATE SET role = excluded.role, name = excluded.name, last_seen_at = max(last_seen_at, excluded.last_seen_at), automatic_look_json = coalesce(excluded.automatic_look_json, automatic_look_json)`);
  const seenList = db.prepare('SELECT * FROM office_agents_seen WHERE last_seen_at >= ? ORDER BY last_seen_at DESC, occupant_id LIMIT ?');
  const seenPrune = db.prepare('DELETE FROM office_agents_seen WHERE last_seen_at < ?');
  const prefGet = db.prepare('SELECT key, value_json FROM ui_prefs');
  const prefPut = db.prepare('INSERT INTO ui_prefs (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at');
  const autoGet = db.prepare('SELECT look_json FROM office_automatic_looks WHERE identity_id = ?');
  const autoCounts = db.prepare('SELECT family, count(*) AS n FROM office_automatic_looks GROUP BY family');
  const autoPut = db.prepare('INSERT INTO office_automatic_looks (identity_id, family, look_json, assigned_at) VALUES (?, ?, ?, ?)');

  const toLayout = (r) => ({ id: r.id, name: r.name, revision: r.revision, updatedAt: r.updated_at, updatedBy: JSON.parse(r.updated_by_json), data: JSON.parse(r.data_json) });
  const tx = (fn) => { if (db.isTransaction) return fn(); db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; } };

  return {
    // A transaction makes least-used selection and first-sight insertion atomic across connections.
    automaticLook(id, index, options = {}) {
      if (typeof id !== 'string') throw new TypeError('invalid automatic appearance identity');
      const { appearanceIdentity, chooseAutomaticLook } = require('../../../public/v2/office/automatic-looks.js');
      id = appearanceIdentity(id);
      const { canonicalRuleId } = require('../../engine/office/layout-rules.js');
      // Long native identities still appear on stage even when the seen inventory cannot index them.
      const longNative = typeof id === 'string' && /^(agent|scheduled|direct|group|conversation):\S+$/.test(id) && cpLength(id) <= 5526;
      if ((canonicalRuleId(id) !== id && !longNative) || id.startsWith('*') || id === 'primary') throw new TypeError('invalid automatic appearance identity');
      const existing = autoGet.get(id);
      if (existing) return JSON.parse(existing.look_json);
      return tx(() => {
        const found = autoGet.get(id);
        if (found) return JSON.parse(found.look_json);
        const usage = new Map(autoCounts.all().map(r => [r.family, Number(r.n)]));
        const chosen = chooseAutomaticLook(index, id, usage, options);
        autoPut.run(id, chosen.family, JSON.stringify(chosen.look), now());
        return chosen.look;
      });
    },
    // The active layout; seeded with `seed()` (the shipped default) the first time.
    active(seed) {
      let r = active.get();
      if (!r && seed) {
        tx(() => {
          if (active.get()) return;
          const id = mintId('lay'), t = now(), data = JSON.stringify(seed());
          insLayout.run(id, 'Bureau principal', data, t, JSON.stringify(SYSTEM));
          insRev.run(id, 1, data, t, JSON.stringify(SYSTEM));
        });
        r = active.get();
      }
      return r ? toLayout(r) : null;
    },
    // → { ok: true, layout } | { ok: false, current } (stale expectedRevision)
    save({ expectedRevision, data, actor }) {
      return tx(() => {
        const r = active.get();
        if (!r || r.revision !== expectedRevision) return { ok: false, current: r ? toLayout(r) : null };
        const next = r.revision + 1, t = now(), json = JSON.stringify(data), by = JSON.stringify(actor);
        upd.run(next, json, t, by, r.id, r.revision);
        insRev.run(r.id, next, json, t, by);
        pruneRev.run(r.id, next - KEEP_REVISIONS);
        return { ok: true, layout: toLayout(active.get()) };
      });
    },
    // Upgrade only the peer rules written by onboarding-1, identified by their configured label.
    // Ordinary delegated-session rules keep their subagent:<subject> identity.
    migrateConfiguredPeers(names = {}) {
      return tx(() => {
        const current = this.active();
        if (!current) return false;
        const data = structuredClone(current.data); let changed = false;
        for (const rule of data.agents || []) {
          if (!rule.agentId?.startsWith('subagent:') || rule.role !== 'Agent' || rule.match?.kind !== 'subagent') continue;
          const id = rule.agentId.slice(9);
          if (!Object.hasOwn(names, id) || rule.name !== names[id]) continue;
          rule.agentId = 'agent:' + id; rule.match.kind = 'agent'; changed = true;
        }
        if (changed) this.save({ expectedRevision: current.revision, data, actor: SYSTEM });
        return changed;
      });
    },
    revisions(layoutId) { return revs.all(layoutId, KEEP_REVISIONS).map((x) => ({ revision: x.revision, updatedAt: x.saved_at, updatedBy: JSON.parse(x.updated_by_json) })); },
    revision(layoutId, n) { const x = rev.get(layoutId, n); return x ? { revision: x.revision, updatedAt: x.saved_at, updatedBy: JSON.parse(x.updated_by_json), data: JSON.parse(x.data_json) } : null; },
    // occupants seen (role from the OfficeVM, name its display name)
    // R24-01: one row per write: a row the schema refuses (over OCCUPANT_ID_MAX, an unknown role) is skipped and counted;
    // it never rolls back the others. → { stored, rejected }
    seen(list, at = now()) {
      let stored = 0, rejected = 0;
      for (const o of list) {
        const subject = typeof o.id === 'string' ? o.id.slice(o.id.indexOf(':') + 1) : null;
        if (typeof o.id !== 'string' || !o.id || cpLength(o.id) > OCCUPANT_ID_MAX && !(cpLength(o.id) <= 5526 && require('../../runtime-ids').parseId(subject))) { rejected++; continue; }
        try { seenUp.run(o.id, o.role, redactChatIdentity(String(o.name).slice(0, 80), { id: o.id, role: o.role, maxLength: 80 }) || 'Agent', at,
          o.automaticLook ? JSON.stringify(o.automaticLook) : null); stored++; } catch (_) { rejected++; }
      }
      return { stored, rejected };
    },
    seenRecent(at = now()) { return seenList.all(at - SEEN_DAYS * 86400000, SEEN_MAX).map((x) => ({ id: x.occupant_id, role: x.role, name: x.name, lastSeenAt: x.last_seen_at,
      ...(x.automatic_look_json && { automaticLook: JSON.parse(x.automatic_look_json) }) })); },
    pruneSeen(at = now()) { return Number(seenPrune.run(at - SEEN_DAYS * 86400000).changes); },
    prefs() { const out = { uiTheme: 'system', locale: null }; for (const r of prefGet.all()) out[r.key] = JSON.parse(r.value_json); return out; },
    setPrefs(patch) { tx(() => { for (const [k, v] of Object.entries(patch)) prefPut.run(k, JSON.stringify(v), now()); }); },
  };
}

module.exports = { createOfficeRepo, KEEP_REVISIONS, SEEN_MAX };
