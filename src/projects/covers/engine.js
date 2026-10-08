'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { fingerprint } = require('./classify');
const { generateCode } = require('./code');
const { createAgentGenerator } = require('./agent');
const { createRasterizer } = require('./raster');
const { createCoverStore } = require('./store');
function bounded(run, ms, controller) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, new Error('cover-aborted'));
    const timer = setTimeout(() => controller.abort(), ms);
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) return abort();
    Promise.resolve().then(run).then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}
function createCoverEngine({ dataDir, getProject, runtime = null, writable = true, agentAllowed = () => true, onChange = () => {},
  urlFor, runTurn, debounceMs = 750, timeoutMs = 60000, rasterize = createRasterizer(), generators = null, now = () => Date.now(), log = () => {} }) {
  const store = createCoverStore({ dataDir, writable, urlFor });
  const code = { id: 'code', supports: () => true, generate: ({ project }) => generateCode(project) };
  const plugins = generators || [createAgentGenerator({ runtime, rasterize, allowed: agentAllowed, timeoutMs, runTurn }), code];
  const queue = new Map(), versions = new Map(), uploads = new Set();
  let running = false, closed = false, timer = null, active = null, activeJob = null;
  const projectOf = (id) => { try { return getProject(id); } catch (_) { return null; } };
  function arm() {
    clearTimeout(timer);
    if (running || closed || !queue.size) return;
    const due = Math.min(...[...queue.values()].map((j) => j.readyAt));
    timer = setTimeout(drain, Math.max(0, due - performance.now())); if (timer.unref) timer.unref();
  }
  function enqueue(project, { force = false, bytes = null, resolve, reject } = {}) {
    if (!writable || closed || !project) return false;
    const record = store.get(project.id), signature = fingerprint(project), existing = queue.get(project.id);
    if (!force && !bytes && activeJob && activeJob.id === project.id && activeJob.fingerprint === signature && versions.get(project.id) === activeJob.version) return false;
    if (!bytes && (uploads.has(project.id) || record && record.source === 'upload')) return false;
    if (!force && !bytes && ((record && record.fingerprint === signature) || (existing && existing.fingerprint === signature))) return false;
    if (existing && existing.reject) existing.reject(new Error('upload-superseded'));
    const version = (versions.get(project.id) || 0) + 1; versions.set(project.id, version);
    queue.set(project.id, { id: project.id, fingerprint: signature, version, bytes, resolve, reject, readyAt: performance.now() + (bytes || force ? 0 : debounceMs) });
    if (bytes) uploads.add(project.id);
    arm(); return true;
  }
  async function drain() {
    if (closed || running) return;
    const job = [...queue.values()].filter((j) => j.readyAt <= performance.now()).sort((a, b) => Number(!!b.bytes) - Number(!!a.bytes) || a.readyAt - b.readyAt)[0];
    if (!job) return arm();
    queue.delete(job.id); running = true; activeJob = job;
    const controller = new AbortController(); active = controller;
    let outputDir, uploaded = false;
    try {
      const project = projectOf(job.id); if (!project) throw new Error('project-gone');
      let result, source;
      if (job.bytes) {
        if (!rasterize) throw new Error('rasterizer-unavailable');
        result = await bounded(() => rasterize(job.bytes, { signal: controller.signal }), timeoutMs, controller); source = 'upload';
      } else {
        outputDir = fs.mkdtempSync(path.join(store.dir, 'job-')); fs.chmodSync(outputDir, 0o700);
        const context = { project, outputDir, signal: controller.signal };
        try {
          await bounded(async () => {
            for (const plugin of plugins) {
              const capability = await plugin.supports(context);
              if (controller.signal.aborted) throw new Error('aborted');
              if (!capability) continue;
              result = await plugin.generate({ ...context, capability }); source = plugin.id;
              const limits = require('./code').LIMITS;
              if (!result || !Buffer.isBuffer(result.cover) || !Buffer.isBuffer(result.thumb) || !['svg', 'webp'].includes(result.ext) || result.cover.length > limits.cover || result.thumb.length > limits.thumb) throw new Error('generator-budget');
              return;
            }
            throw new Error('no-generator');
          }, timeoutMs, controller);
        } catch (_) { log('covers: generator failed; code fallback'); result = generateCode(project); source = 'code'; }
      }
      const latest = projectOf(job.id), record = store.get(job.id);
      if (closed || versions.get(job.id) !== job.version || !latest || (!job.bytes && (fingerprint(latest) !== job.fingerprint || record && record.source === 'upload' || uploads.has(job.id)))) {
        if (job.reject) job.reject(new Error('cover-superseded'));
        return;
      }
      store.save(job.id, result, { source, fingerprint: job.bytes ? fingerprint(latest) : job.fingerprint, generatedAt: now() });
      uploaded = !!job.bytes;
      onChange(job.id);
      if (job.resolve) job.resolve(store.vm(job.id));
    } catch (_) { log('covers: generation failed'); if (job.reject) job.reject(new Error('cover-failed')); }
    finally {
      if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
      if (job.bytes && !(queue.get(job.id) || {}).bytes) uploads.delete(job.id);
      running = false; active = null; activeJob = null;
      if (job.bytes && !uploaded && !uploads.has(job.id)) enqueue(projectOf(job.id));
      arm();
    }
  }
  return {
    store,
    vm: (id) => store.vm(id),
    observe: (project) => enqueue(project),
    regenerate: (id) => enqueue(projectOf(id), { force: true }),
    upload(id, bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length > 48 * 1024) return Promise.reject(new Error('upload-size'));
      return new Promise((resolve, reject) => { if (!enqueue(projectOf(id), { bytes, resolve, reject })) reject(new Error('readonly')); });
    },
    get pending() { return queue.size + Number(running); },
    close() {
      closed = true; clearTimeout(timer); if (active) active.abort();
      for (const job of queue.values()) if (job.reject) job.reject(new Error('closed'));
      queue.clear();
    },
  };
}
module.exports = { createCoverEngine, bounded };
