// Character inspector copy loads with the editor.
import { registerMessages } from '../messages.js';
import { LABELS_EN } from '../locales/labels.en.js';
const fr = {
  'office.characters.count.one': '{n} agent', 'office.characters.count.other': '{n} agents',
  'office.characters.detected': 'Détecté · hors du bureau', 'office.characters.detectedGroup': 'Détectés récemment',
  'office.characters.emptyAll': 'Aucun agent détecté pour cette recherche.', 'office.characters.emptyOffice': 'Aucun agent présent dans le bureau pour cette recherche.',
  'office.characters.independent': 'Agents sans équipe', 'office.characters.showAll': 'Afficher tous les agents détectés',
  'office.characters.search': 'Rechercher un agent',
  'office.characters.identityAndPlacement': 'Identité et emplacement',
  'office.characters.back': 'Retour à la liste',
  'office.characters.loadError': 'La liste des agents n’a pas pu être chargée.', 'office.characters.loading': 'Chargement des agents…',
};
const en = {
  'office.characters.count.one': '{n} agent', 'office.characters.count.other': '{n} agents',
  'office.characters.detected': 'Detected · not in the office', 'office.characters.detectedGroup': 'Recently detected',
  'office.characters.emptyAll': 'No detected agents match this search.', 'office.characters.emptyOffice': 'No agents in the office match this search.',
  'office.characters.independent': 'Agents without a team', 'office.characters.showAll': 'Show all detected agents',
  'office.characters.search': 'Search agents',
  'office.characters.identityAndPlacement': 'Identity and placement',
  'office.characters.back': 'Back to agents',
  'office.characters.loadError': 'The agent list could not be loaded.', 'office.characters.loading': 'Loading agents…',
};
registerMessages({fr,en});
const { 'office.characters.back': back, ...labels } = en; // Back is UI-only.
Object.assign(LABELS_EN,labels);
