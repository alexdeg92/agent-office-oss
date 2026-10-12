import { registerMessages } from '../messages.js';

export const fr = {
  'workspace.filters': 'Filtres', 'workspace.filtersActive': 'Filtres ({n})', 'workspace.apply': 'Appliquer', 'workspace.reset': 'Réinitialiser',
'chat.margin.window': { zero: 'Aucun message dans ce fil.', one: 'Un message affiché (les 50 derniers au plus).', other: 'Messages affichés : {n} (les 50 derniers au plus).' },
};
export const en = {
  'workspace.filters': 'Filters', 'workspace.filtersActive': 'Filters ({n})', 'workspace.apply': 'Apply', 'workspace.reset': 'Reset',
'chat.margin.window': { zero: 'No message in this thread.', one: 'One message shown (the latest 50 at most).', other: 'Messages shown: {n} (the latest 50 at most).' },
};
registerMessages({ fr, en });
