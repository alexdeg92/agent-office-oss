// Mock Compétences: SkillListVM / SkillDetailVM (api.md 2.0 §3.7) and the toggle + gateway restart commands (§5.1).
// Invented French data only. A toggle sets needsRestart until the (mock) gateway restarts.
const SOURCES = ['bundled', 'extra', 'workspace', 'workshop', 'custodian'];

// [id, emoji, description, source, eligible, disabled, visibility(m,c,u), steps, outputs, requirements, missing]
const RAW = [
  ['meteo', '⛅', 'Prévisions météo pour une ville, sur trois jours.', 'bundled', true, false, [1, 0, 1], ['Lire la ville demandée', 'Appeler le service météo', 'Résumer en trois jours'], ['message'], { bins: ['curl'] }],
  ['recherche-web', '🔎', 'Recherche sur le Web et synthèse des sources pertinentes.', 'bundled', true, false, [1, 1, 1], ['Formuler les requêtes', 'Lire les résultats', 'Croiser les sources', 'Rédiger la synthèse avec liens'], ['message', 'agent-reply']],
  ['resume-pdf', '📄', 'Résume un PDF reçu en pièce jointe.', 'bundled', true, false, [1, 0, 1], ['Extraire le texte', 'Découper par sections', 'Résumer chaque section'], ['agent-reply'], { bins: ['pdftotext'] }],
  ['factures', '🧾', 'Génère les factures mensuelles à partir des feuilles de temps.', 'workspace', true, false, [1, 1, 0], ['Lire les feuilles de temps', 'Calculer les montants', 'Produire les PDF', 'Envoyer après validation'], ['files', 'message'], { bins: ['node'], env: ['FACTURES_DOSSIER'] }],
  ['agenda', '📅', 'Lit et propose des créneaux dans l’agenda partagé.', 'extra', false, false, [1, 1, 1], ['Lire l’agenda', 'Trouver les créneaux libres', 'Proposer trois options'], ['message'], { bins: ['gcalcli'], env: ['AGENDA_ID'] }, { bins: ['gcalcli'] }],
  ['traduction', '🌐', 'Traduit un texte entre le français et l’anglais en gardant le ton.', 'bundled', true, false, [1, 0, 1], ['Détecter la langue', 'Traduire', 'Relire le ton'], ['agent-reply']],
  ['git-sommaire', '🌿', 'Résume les commits récents d’un dépôt.', 'workshop', true, false, [1, 1, 0], ['Lister les commits', 'Grouper par sujet', 'Rédiger le sommaire'], ['message'], { bins: ['git', 'gh'] }],
  ['sauvegarde', '💾', 'Lance la copie chiffrée vers le second disque.', 'custodian', true, true, [0, 1, 0], ['Vérifier le disque cible', 'Chiffrer et copier', 'Contrôler les sommes'], ['tool-actions', 'files'], { bins: ['restic'], env: ['RESTIC_PASSWORD_FILE'] }],
  ['veille', '🔭', 'Parcourt les sites des concurrents suivis et note les nouveautés.', 'workshop', true, false, [1, 1, 0], ['Charger la liste des sites', 'Comparer avec la semaine passée', 'Noter les nouveautés'], ['files', 'agent-reply']],
  ['images-redim', '🖼️', 'Redimensionne et compresse un lot d’images.', 'extra', false, false, [0, 1, 1], ['Lire le dossier', 'Redimensionner', 'Compresser'], ['files'], { bins: ['magick'] }, { bins: ['magick'] }],
  ['courriel-tri', '📬', 'Trie la boîte de réception et propose des réponses.', 'extra', true, true, [1, 0, 1], ['Lire les nouveaux courriels', 'Classer par priorité', 'Préparer des brouillons'], ['message', 'tool-actions'], { env: ['IMAP_HOST'] }],
  ['notes-reunion', '🗒️', 'Transforme des notes brutes en compte rendu structuré.', 'bundled', true, false, [1, 0, 1], ['Repérer décisions et tâches', 'Structurer le compte rendu'], ['agent-reply', 'files']],
  ['seo-audit', '📈', 'Vérifie balises, titres et liens morts d’un site.', 'workspace', true, false, [1, 1, 0], ['Explorer les pages', 'Vérifier les balises', 'Lister les liens morts', 'Proposer des correctifs'], ['files', 'message'], { bins: ['node'] }],
  ['tableur', '📊', 'Lit et met à jour une feuille de calcul.', 'bundled', true, false, [1, 1, 1], ['Ouvrir la feuille', 'Appliquer les changements', 'Vérifier les totaux'], ['files']],
  ['minuteur', '⏱️', 'Rappelle une tâche après un délai.', 'bundled', true, false, [0, 1, 1], ['Lire le délai', 'Programmer le rappel'], ['message']],
  ['plateforme-mac', '🍎', 'Raccourcis propres à macOS.', 'bundled', false, false, [1, 0, 0], ['Vérifier la plateforme', 'Exécuter le raccourci'], ['tool-actions'], { os: ['darwin'] }, { os: ['darwin'] }],
];
const FILLER = [['transcription', '🎙️', 'Transcrit un fichier audio.'], ['qr-code', '🔳', 'Génère un code QR.'], ['devises', '💱', 'Convertit des montants entre devises.'],
  ['calcul', '🧮', 'Fait des calculs détaillés.'], ['horaire-bus', '🚌', 'Donne les prochains passages d’autobus.'], ['recettes', '🍲', 'Propose des recettes avec ce qu’il reste.'],
  ['citations', '💬', 'Retrouve une citation et sa source.'], ['dictionnaire', '📚', 'Définitions et synonymes.'], ['fuseaux', '🕰️', 'Convertit des heures entre fuseaux.'],
  ['markdown-pdf', '📑', 'Convertit un document Markdown en PDF.'], ['lien-court', '🔗', 'Raccourcit un lien.'], ['meteo-alertes', '⚠️', 'Signale les alertes météo locales.'],
  ['budget', '💰', 'Classe les dépenses du mois.'], ['inventaire', '📦', 'Tient l’inventaire de l’atelier.'], ['contrat', '✍️', 'Vérifie les clauses d’un contrat type.'],
  ['photos-tri', '🗂️', 'Trie les photos par date et lieu.'], ['ocr', '🔤', 'Lit le texte d’une image.'], ['sondage', '🗳️', 'Prépare un sondage Discord.'],
  ['podcast', '🎧', 'Résume un épisode de balado.'], ['cartes', '🗺️', 'Calcule un itinéraire.'], ['rss', '📰', 'Suit des flux RSS.'], ['github-issues', '🐞', 'Trie les tickets GitHub.'],
  ['nettoyage', '🧹', 'Repère les fichiers en double.'], ['mots-de-passe', '🔐', 'Génère des phrases de passe.']];

function markdownFor(id, desc, steps) {
  return `# ${id}\n\n${desc}\n\n## Quand l’utiliser\n\nQuand Owner ou un interlocuteur le demande, ou quand une tâche planifiée l’appelle.\n\n## Étapes\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n## Exemple\n\n\`\`\`\n/${id} « ${desc.split(' ').slice(0, 4).join(' ')} … »\n\`\`\`\n\n**Important :** ne jamais envoyer de données personnelles hors du serveur. Voir aussi la [documentation](https://exemple.ca/docs/${id}).\n`;
}
const reqs = (r = {}) => ({ bins: r.bins || [], anyBins: r.anyBins || [], env: r.env || [], config: r.config || [], os: r.os || [] });

export function createSkills() {
  const skills = new Map();
  const add = ([id, emoji, description, source, eligible, disabled, vis, steps, outputs, requirements, missing]) => skills.set(id, {
    id, emoji, description, source, eligible, disabled, visibility: { model: !!vis[0], command: !!vis[1], user: !!vis[2] },
    homepage: source === 'bundled' ? `https://exemple.ca/competences/${id}` : null, steps, outputs,
    requirements: requirements ? reqs(requirements) : null, missing: missing ? reqs(missing) : null, needsRestart: false,
    always: id === 'minuteur', blockedBy: { allowlist: false, agentFilter: false, platform: !!(missing && missing.os) },
    install: missing && missing.bins ? missing.bins.map((b) => ({ id: 'brew-' + b, kind: 'brew', label: `Installer ${b} (Homebrew)`, bins: [b] })) : [],
    infoFails: id === 'courriel-tri',
  });
  RAW.forEach(add);
  FILLER.forEach(([id, emoji, desc], i) => add([id, emoji, desc, SOURCES[i % SOURCES.length], i % 7 !== 3, i % 9 === 4, [i % 2, (i + 1) % 2, 1],
    ['Comprendre la demande', 'Préparer les données', 'Produire le résultat'], [['agent-reply', 'files', 'message', 'tool-actions'][i % 4]], null]));

  const status = (s) => (s.disabled ? 'disabled' : s.eligible ? 'active' : 'unavailable');
  const row = (s) => ({ id: s.id, emoji: s.emoji, description: s.description, source: s.source, status: status(s), visibility: { ...s.visibility } });
  const ORDER = { active: 0, unavailable: 1, disabled: 2 };
  return {
    list() {
      const all = [...skills.values()].sort((a, b) => ORDER[status(a)] - ORDER[status(b)] || a.id.localeCompare(b.id, 'fr'));
      return { skills: all.map(row), counts: { total: all.length, active: all.filter((s) => status(s) === 'active').length } };
    },
    detail(id) {
      const s = skills.get(id);
      if (!s) return null;
      return {
        skill: { ...row(s), homepage: s.homepage },
        detail: s.infoFails ? null : { always: s.always, blockedBy: { ...s.blockedBy }, requirements: s.requirements, missing: s.missing, install: s.install },
        markdown: markdownFor(s.id, s.description, s.steps),
        flow: { steps: s.steps, outputs: s.outputs },
        needsRestart: s.needsRestart,
      };
    },
    /** PUT /skills/:name/enabled → { status, body } like the server. */
    toggle(id, body) {
      const s = skills.get(id);
      if (!s) return { error: [404, 'not_found', 'Cette compétence n’existe pas.'] };
      if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).length !== 1) return { error: [400, 'validation_failed', 'Certaines valeurs sont invalides.', [{ field: 'enabled', issue: 'invalid' }]] };
      if (s.disabled === !body.enabled) return { result: { needsRestart: s.needsRestart } };
      s.disabled = !body.enabled;
      s.needsRestart = !s.needsRestart;
      return { result: { needsRestart: true } };
    },
    pendingRestart: () => [...skills.values()].some((s) => s.needsRestart),
    restarted() { for (const s of skills.values()) s.needsRestart = false; },
  };
}
