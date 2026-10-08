'use strict';
const { performance } = require('node:perf_hooks');
// Read-only capability discovery. Never infer image generation from vision support or an agent's name.
const generatorName = /(?:^|[^a-z])(?:image[_-]?gen(?:erate|eration)?|generate[_-]?image|text[_-]?to[_-]?image|nano[_-]?banana)(?:$|[^a-z])/i;
function generatesImage(item) {
  if (!item || item.disabled || item.eligible === false || item.blockedByAllowlist || item.blockedByAgentFilter || item.deniedBySession || item.available === false) return false;
  if (item.capabilities && item.capabilities.imageGeneration === true) return true;
  return generatorName.test(item.id || item.name || '') || /(?:generate|create|generation de|generer|creer)\s+(?:\w+\s+){0,3}(?:images?|illustrations?|pictures?)/i.test(item.description || item.fullDescription || '');
}
function parse(cli, out) {
  const first = String(out || '').search(/[\[{]/);
  try { return JSON.parse(String(out).slice(first)); } catch (_) { return cli.parseJson(out); }
}
function bindImageCapabilities({ gw, cli }) {
  const skillCache = new Map();
  return async ({ sessionSlug, signal } = {}) => {
    const listed = await gw.call('agents.list', {});
    const agents = (listed && listed.agents || []).filter((a) => a && /^[a-zA-Z0-9_-]{1,80}$/.test(a.id)).slice(0, 64).sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const out = [];
    for (const agent of agents) {
      if (signal && signal.aborted) throw new Error('aborted');
      const sessionKey = `agent:${agent.id}:ao-projet-${sessionSlug}`;
      let tools = null;
      // The effective inventory honors tool policy in this exact project session, when supported by the runtime.
      try { tools = await gw.call('tools.effective', { agentId: agent.id, sessionKey }); }
      catch (_) { try { tools = await gw.call('tools.catalog', { agentId: agent.id, includePlugins: true }); } catch (_) { /* older runtimes */ } }
      if (signal && signal.aborted) throw new Error('aborted');
      let cached = skillCache.get(agent.id);
      if (!cached || cached.expiresAt <= performance.now()) {
        const skillsRead = await cli.run(['skills', 'list', '--agent', agent.id, '--json'], 10000, { signal, background: true });
        cached = { value: skillsRead && skillsRead.ok ? parse(cli, skillsRead.out) : null, expiresAt: performance.now() + 120000 };
        if (cached.value && !(signal && signal.aborted)) {
          if (skillCache.size >= 64) skillCache.delete(skillCache.keys().next().value);
          skillCache.set(agent.id, cached);
        }
      }
      const skills = cached.value;
      const entries = tools ? (tools.tools || []).concat((tools.groups || []).flatMap((g) => g.tools || [])) : (agent.tools || []);
      const usableTools = entries.filter((t) => !t.disabled && !t.deniedBySession && t.available !== false);
      // A generation skill needs an execution tool. A model must explicitly advertise generation, never just input:image.
      const skillEvidence = (skills && skills.skills || agent.skills || []).filter(generatesImage);
      const models = [agent.model].concat(agent.models || []).filter((m) => m && typeof m === 'object');
      const evidence = usableTools.filter(generatesImage).map((t) => 'tool:' + (t.id || t.name))
        .concat(skillEvidence.length && usableTools.some((t) => ['exec', 'process', 'bash'].includes(t.id || t.name)) ? skillEvidence.map((s) => 'skill:' + s.name) : [])
        .concat(models.filter((m) => m.capabilities && m.capabilities.imageGeneration === true).map((m) => 'model:' + (m.id || m.primary || 'generation')));
      if (evidence.length) out.push({ agentId: agent.id, model: agent.model || null, evidence });
    }
    return out;
  };
}
module.exports = { bindImageCapabilities, generatesImage };
