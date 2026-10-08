// Mock Discuter (api.md §3.3 ChatVM, §5.2): the fixed portal-chat session, invented French content only.
// One pending turn at a time; the reply (or a failed turn's `error` message) arrives a few seconds later.
const MIN = 60_000;
const REPLIES = [
  'C’est noté. J’ai relu les notes du projet : deux points restent à vérifier, l’envoi du formulaire et la confirmation sur téléphone. Je vous propose de commencer par l’envoi.',
  'Voici un résumé en trois points :\n\n1. Le parcours d’accueil fonctionne.\n2. Le formulaire s’envoie, mais la confirmation n’apparaît pas sur petit écran.\n3. Rien n’a été publié.',
  'Je n’ai pas trouvé d’information récente sur ce sujet dans l’espace de travail. Voulez-vous que je cherche ailleurs ?',
];

export function createChat(now = Date.now(), { empty = false, failTurns = false, full = false } = {}) {
  let n = 0;
  const id = () => 'm_' + (++n);
  const messages = empty ? [] : [
    { id: id(), role: 'user', at: now - 26 * 60 * MIN, text: 'Peux-tu préparer la liste des factures à envoyer cette semaine ?', meta: null },
    { id: id(), role: 'assistant', at: now - 26 * 60 * MIN + 74_000, text: 'Voici les factures prêtes à partir :\n\n- **Atelier Démo**, septembre\n- **Chez Lucie**, deuxième acompte\n\nLes deux autres attendent une validation.', meta: { model: 'gpt-5.5', tokens: 1240, durationMs: 74_000 } },
    { id: id(), role: 'user', at: now - 12 * MIN, text: 'Vérifie le portail avant la livraison. Je veux surtout savoir si le formulaire fonctionne sur téléphone.', meta: null },
    { id: id(), role: 'assistant', at: now - 9 * MIN, text: 'Le parcours d’accueil est accessible. Pour le formulaire, il reste à vérifier l’envoi et la confirmation sur un petit écran.', meta: { model: 'gpt-5.5', tokens: 2310, durationMs: 154_000 } },
  ];
  // ?chat-plein=1: a full window (50 messages) so every new message evicts an old one (R19-05 regression).
  if (full) while (messages.length < 50) messages.unshift({ id: 'old_' + messages.length, role: 'user', at: now - 40 * 60 * MIN + messages.length, text: 'Message ancien ' + messages.length + '.', meta: null });
  let pending = null;
  let replies = 0;
  return {
    vm: () => ({ sessionKey: 'agent:main:explicit:portal-chat', turnPending: pending ? { turnId: pending.turnId, since: pending.since } : null, messages: messages.slice(-50) }),
    /** POST /api/v2/chat/messages → { turnId } | { error: [status, code, message, details] } */
    post(text, changed) {
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) return { error: [400, 'validation_failed', 'Le message doit contenir entre 1 et 8000 caractères.', [{ field: 'text', issue: 'length' }]] };
      if (pending) return { error: [409, 'conflict', 'Une réponse est déjà en préparation.', [{ issue: 'turn-pending' }]] };
      const turnId = 'turn_' + (++n);
      pending = { turnId, since: Date.now() };
      messages.push({ id: 'pending_' + turnId, role: 'user', at: Date.now(), text, meta: null });
      setTimeout(() => {
        const m = messages.find((x) => x.id === 'pending_' + turnId);
        if (m) m.id = id();   // the transcript now has it
        if (failTurns) messages.push({ id: 'err_' + turnId, role: 'error', at: Date.now(), text: 'La réponse n’a pas pu être obtenue (Délai dépassé)', meta: null });
        else messages.push({ id: id(), role: 'assistant', at: Date.now(), text: REPLIES[replies++ % REPLIES.length], meta: { model: 'gpt-5.5', tokens: 800 + 137 * replies, durationMs: Date.now() - pending.since } });
        pending = null;
        changed();
      }, 4500);
      return { turnId };
    },
  };
}
