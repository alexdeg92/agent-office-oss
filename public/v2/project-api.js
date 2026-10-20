// Project commands reconcile 200/409 VMs through the owning view's transport (api.md §5.4).
import { request, toastError } from './api.js';
import { toast } from './toast.js';
import { services } from './services.js';

const enc = encodeURIComponent;
export const projectPath = (id, rest = '') => `/api/v2/projects/${enc(id)}${rest}`;
export const projectTopic = (id) => 'project:' + id;

// Legacy callers use services.stream and the app version. Each write requires a revision.
export async function projectWrite({ method, id, path = '', body = {}, expectedRevision, topics = [], success = null, stream = services.stream, apiVersion }) {
  if (!Number.isInteger(expectedRevision)) throw new Error('projectWrite: expectedRevision is required');
  try {
    const r = await request(method, projectPath(id, path), { ...body, expectedRevision }, { quiet: true, apiVersion });
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
