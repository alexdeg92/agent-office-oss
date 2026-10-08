'use strict';
const crypto = require('node:crypto');
const TYPES = {
  bug: ['bug', 'bogue', 'regression', 'correctif', 'crash', 'fix'],
  newsletter: ['infolettre', 'newsletter', 'bulletin'],
  website: ['site web', 'site', 'web', 'website', 'landing page', 'web site', 'site vitrine'],
  data: ['donnees', 'data', 'dataset', 'analytics', 'analyse', 'sql', 'etl'],
  doc: ['documentation', 'document', 'doc', 'guide', 'rapport', 'manuel', 'specification'],
  ops: ['ops', 'automatisation', 'workflow', 'cron', 'devops', 'infra', 'infrastructure', 'deployment', 'deploiement', 'backup', 'sauvegarde', 'monitoring'],
  marketing: ['marketing', 'campagne', 'campaign', 'publicite', 'advertising', 'branding', 'seo'],
  app: ['app', 'application', 'logiciel', 'software', 'pwa', 'saas', 'dashboard', 'api'],
};
const normalize = (v) => String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function projectSlug(project) {
  const tag = (project.sources || []).find((s) => s.kind === 'sessionGroup' && String(s.ref && s.ref.groupId || '').startsWith('projet:'));
  return normalize(tag && tag.ref.name || project.name).replace(/ /g, '-').slice(0, 60) || project.id;
}
function inputsOf(project) {
  return {
    name: String(project.name || '').slice(0, 80), summary: String(project.summary || '').slice(0, 4000),
    labels: (project.flags || []).filter((f) => f.kind === 'label').map((f) => f.label || f.key).concat(project.labels || []).map(String).sort(),
    status: String(project.status || ''), sources: (project.sources || []).map((s) => ({ kind: s.kind, ref: s.ref })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')),
    slug: projectSlug(project),
  };
}
function classify(project) {
  const p = inputsOf(project);
  const parts = [[p.labels.join(' '), 8], [p.name, 4], [p.summary, 2], [JSON.stringify(p.sources), 1], [p.status, 1]];
  let best = 'project', max = 0;
  for (const [type, words] of Object.entries(TYPES)) {
    let score = 0;
    for (const [text, weight] of parts) {
      const normalized = ' ' + normalize(text) + ' ';
      for (const word of words) if (normalized.includes(' ' + word + ' ')) score += weight;
    }
    if (score > max) { max = score; best = type; }
  }
  return best;
}
// Summary/name changes refresh the visual; status/labels/sources refresh only if they change its classified type.
function fingerprint(project) {
  const p = inputsOf(project);
  return crypto.createHash('sha256').update(JSON.stringify([1, p.slug, p.name, p.summary, classify(project)])).digest('hex');
}
module.exports = { TYPES, classify, inputsOf, projectSlug, fingerprint };
