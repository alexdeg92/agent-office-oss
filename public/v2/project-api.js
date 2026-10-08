// The single path for every write to an existing project (api.md 2.0 §5.4). Each write carries `expectedRevision`.
// - 200: Ok<CommandResult> = { ok, result, revision, vm }; `vm` is the fresh ProjectVM, shown at once on `project:<id>`.
// - 409: error.current = { revision, vm: ProjectVM } is the authoritative state; it's shown at once, and the boards
//   (which show the project as a card) resync. A 409 without `current` (e.g. source-in-use) changes nothing.
import { request, toastError } from './api.js';
import { toast } from './toast.js';
import { services } from './services.js';

const enc = encodeURIComponent;
export const projectPath = (id, rest = '') => `/api/v2/projects/${enc(id)}${rest}`;
export const projectTopic = (id) => 'project:' + id;

/**
 * projectWrite({ method, id, path, body, expectedRevision, topics, success })
 *   path: '' | '/status' | '/flags' | '/flags/label/<key>' | '/flags/risk/<key>/ack' | '/sources' | …
 *   topics: extra SSE topics showing this project (boards) to resync on 409
 *   success: toast text, or (data) => toast options
 * → { ok: true, revision, result, vm } | { ok: false, error, current }. Errors are toasted here (a conflict as a warning).
 */
export async function projectWrite({ method, id, path = '', body = {}, expectedRevision, topics = [], success = null }) {
  if (!Number.isInteger(expectedRevision)) throw new Error('projectWrite: expectedRevision is required');
  const stream = services.stream;
  try {
    const r = await request(method, projectPath(id, path), { ...body, expectedRevision }, { quiet: true });
    const data = (r && r.data) || {};
    if (data.vm && stream) stream.applyVM(projectTopic(id), data.vm);
    if (success) toast(typeof success === 'function' ? success(data) : { level: 'success', message: success });
    return { ok: true, revision: data.revision ?? null, result: data.result ?? null, vm: data.vm ?? null };
  } catch (error) {
    const current = error && error.current ? error.current : null;
    if (error.code === 'conflict') {
      toast({ level: 'warning', message: error.message, code: 'CONFLICT', requestId: error.requestId });
      if (current && current.vm && stream) stream.applyVM(projectTopic(id), current.vm);
      if (current && stream) for (const t of topics) stream.resync(t);
    } else if (error.code !== 'unauthorized') {
      toastError(error);
    }
    return { ok: false, error, current };
  }
}
