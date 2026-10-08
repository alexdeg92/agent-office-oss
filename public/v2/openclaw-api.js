// The single path for OpenClaw writes from the UI (api.md §5.0 class « OpenClaw »: flows, skills, restart, chat).
// - 403 readonly (staging): the server's message « Instance de test : actions désactivées. » is shown as a warning.
// - 400 validation_failed: returned to the caller, so a form can show it under the right field (details[].field).
// - anything else: an error toast.
import { request, toastError } from './api.js';
import { toast } from './toast.js';

/** → { ok: true, data: CommandResult } | { ok: false, error } */
export async function openclawWrite(method, path, body = {}, { success = null, formErrors = false } = {}) {
  try {
    const r = await request(method, path, body, { quiet: true });
    const data = (r && r.data) || {};
    if (success) toast(typeof success === 'function' ? success(data) : { level: 'success', message: success });
    return { ok: true, data };
  } catch (error) {
    if (error.code === 'readonly') toast({ level: 'warning', message: error.message, code: 'READONLY', requestId: error.requestId });
    else if (error.code === 'validation_failed' && formErrors) { /* the form shows it */ }
    else if (error.code !== 'unauthorized') toastError(error);
    return { ok: false, error };
  }
}

/** Maps a validation error to { field: message } (unknown fields go under `_form`). */
export function fieldErrors(error, fields) {
  if (!error || error.code !== 'validation_failed') return {};
  const out = {};
  for (const d of error.details || []) out[fields.includes(d.field) ? d.field : '_form'] = error.message;
  if (!Object.keys(out).length) out._form = error.message;
  return out;
}
