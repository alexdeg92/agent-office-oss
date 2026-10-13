// App-wide singletons shared by pages.
export const services = { router: null, stream: null, me: null, meta: null };
// Drafts supply reload confirmation.
export const reloadGuards = new Set();
export const hasDirtyDraft = () => [...reloadGuards].some(g => g.dirty());
export async function allowReload() {
  for (const guard of reloadGuards) guard.approved = false;
  for (const guard of reloadGuards) if (guard.dirty() && !await guard.confirm()) return false;
  for (const guard of reloadGuards) guard.approved = true;
  return true;
}
