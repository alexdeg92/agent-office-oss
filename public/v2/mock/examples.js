// The authoritative contract examples (docs/architecture/examples/, api.md 2.1), copied here by scripts/sync-design.js.
// The mocks are built FROM them: every VM a mock builds goes through `conform(example, vm)`, which keeps exactly the
// example's keys (an extra key is dropped, a missing key throws), and the example entities are part of the mock data.
// test/frontend/contract.test.js checks the result with the architect's compareShape.
import projectVm from './examples/project-vm.json' with { type: 'json' };
import boardVm from './examples/board-vm.json' with { type: 'json' };
import candidatesVm from './examples/candidates-vm.json' with { type: 'json' };
import importResult from './examples/import-result.json' with { type: 'json' };
import historyPage from './examples/history-page.json' with { type: 'json' };
import sessionVm from './examples/session-vm.json' with { type: 'json' };
import error409 from './examples/error-409-project.json' with { type: 'json' };
import healthVm from './examples/health-vm.json' with { type: 'json' };

import comments from './examples/comment-thread-vm.json' with { type: 'json' };

export const EXAMPLES = { projectVm, boardVm, candidatesVm, importResult, historyPage, sessionVm, error409, healthVm, comments };

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const variantOf = (el) => { if (typeOf(el) !== 'object') return null; for (const d of ['kind', 'type', 'op']) if (typeof el[d] === 'string') return d + '=' + el[d]; return null; };
// Objects with dynamic keys (LabelRef params, import overrides) are values, not shapes; so is a source `ref`,
// a union without a `kind` (`{by:'keys'}` vs `{by:'interlocutor'}`, github vs workspace).
const RECORDS = new Set(['params', 'overrides', 'labels', 'enums', 'ref']);

/**
 * conform(example, actual) → actual projected onto the example's shape.
 * Objects keep exactly the example's keys; arrays map each element onto the example element of the same variant
 * (or the first one); a variant the example doesn't show keeps its own keys (data-model allows it).
 */
export function conform(example, actual, path = '$', key = '') {
  if (actual === null || example === null || example === undefined) return actual;
  if (RECORDS.has(key)) return actual;
  const te = typeOf(example), ta = typeOf(actual);
  if (te !== ta) throw new Error(`mock shape: ${path} is ${ta}, the example has ${te}`);
  if (te === 'array') {
    if (!example.length) return actual;
    // Elements of one uniform type (same keys, e.g. HistoryItemVM whatever its kind) share the first element's shape.
    const keysOf = (x) => (typeOf(x) === 'object' ? Object.keys(x).sort().join() : typeOf(x));
    const uniform = example.every((x) => keysOf(x) === keysOf(example[0]));
    return actual.map((el) => {
      const v = variantOf(el);
      // A Collection with fixed ids (HealthVM.cards): the example element with the same id is the model.
      // …but only within the same variant: trace event ids (ev:1:0) repeat across sessions, and a user event must not
      // be shaped like the example's thinking event that happens to share its id (it would lose `sender`).
      const byId = el && typeof el.id === 'string' ? example.find((x) => x && x.id === el.id && (!v || variantOf(x) === v)) : null;
      const model = byId || (v && example.find((x) => variantOf(x) === v)) || (uniform || !v ? example[0] : null);
      return model ? conform(model, el, path + '[]') : el;
    });
  }
  if (te !== 'object') return actual;
  // A different variant of a union (e.g. actor {kind:'system', name} where the example shows a PersonChip): keep it.
  if (typeof example.kind === 'string' && typeof actual.kind === 'string' && example.kind !== actual.kind && !Object.keys(example).every((k) => k in actual)) return actual;
  const out = {};
  for (const k of Object.keys(example)) {
    if (!(k in actual)) {
      if (k === 'params') continue; // LabelRef.params is optional
      throw new Error(`mock shape: ${path}.${k} is missing`);
    }
    out[k] = conform(example[k], actual[k], `${path}.${k}`, k);
  }
  // LabelRef.params is optional: keep it even when this example item happens to have none.
  if ('key' in example && !('params' in example) && actual.params !== undefined) out.params = actual.params;
  if (actual.kind === 'session' && actual.session !== undefined) out.session = actual.session;
  return out;
}

/** The example's `data` (deep copy), to seed mock data with the example entities. */
export const exampleData = (ex) => structuredClone(ex.data);
