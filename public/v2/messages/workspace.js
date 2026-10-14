import { registerMessages } from '../messages.js';
import { LABELS_EN } from '../locales/labels.en.js';
// These backend label fallbacks belong to the Chat route, alongside its cards.
Object.assign(LABELS_EN, {
  'chat.result.status.completed': 'Completed',
  'chat.result.status.failed': 'Failed',
  'chat.result.status.running': 'Running',
  'chat.result.status.unknown': 'Status unknown',
});

export const fr = {
  'chat.subagentResult': 'Résultat du sous-agent',
  'workspace.filters': 'Filtres', 'workspace.filtersActive': 'Filtres ({n})', 'workspace.apply': 'Appliquer', 'workspace.reset': 'Réinitialiser',
'chat.margin.window': { zero: 'Aucun message dans ce fil.', one: 'Un message affiché (les 50 derniers au plus).', other: 'Messages affichés : {n} (les 50 derniers au plus).' },
};
export const en = {
  'chat.subagentResult': 'Subagent result',
  'workspace.filters': 'Filters', 'workspace.filtersActive': 'Filters ({n})', 'workspace.apply': 'Apply', 'workspace.reset': 'Reset',
'chat.margin.window': { zero: 'No message in this thread.', one: 'One message shown (the latest 50 at most).', other: 'Messages shown: {n} (the latest 50 at most).' },
};
registerMessages({ fr, en });
