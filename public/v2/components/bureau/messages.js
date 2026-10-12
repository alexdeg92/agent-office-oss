import { registerMessages } from '../../messages.js';

const dictionary = {
  fr: {
    'bureauControl.environment': "Défini par l'environnement : {variable}",
    'bureauControl.empty': 'Non renseigné',
    'bureauControl.copy': 'Copier',
    'bureauControl.copyLabel': 'Copier {label}',
    'bureauControl.copied': 'Copié',
    'bureauControl.copyFailed': 'Copie impossible. Sélectionnez et copiez le texte manuellement.',
    'bureauControl.actionTarget': '{action} : {target}',
    'bureauControl.status.error': 'Erreur',
    'bureauControl.status.warn': 'À vérifier',
    'bureauControl.status.info': 'Information',
    'bureauControl.status.ok': 'En ordre',
    'bureauControl.status.unknown': 'Non vérifié',
    'bureauControl.details': 'Détails', 'bureauControl.accept': 'Valider', 'bureauControl.editName': 'Modifier le nom de {name}',
    'bureauControl.inlineRequired': 'Saisissez une valeur.', 'bureauControl.inlineMax': 'Utilisez au plus {n} caractères.',
    'bureauControl.secretStored': 'Jeton configuré', 'bureauControl.replace': 'Remplacer', 'bureauControl.secretKeep': 'Laissez le champ vide pour conserver le jeton existant.',
  },
  en: {
    'bureauControl.environment': 'Set by the environment: {variable}',
    'bureauControl.empty': 'Not set',
    'bureauControl.copy': 'Copy',
    'bureauControl.copyLabel': 'Copy {label}',
    'bureauControl.copied': 'Copied',
    'bureauControl.copyFailed': 'Could not copy. Select and copy the text manually.',
    'bureauControl.actionTarget': '{action}: {target}',
    'bureauControl.status.error': 'Error',
    'bureauControl.status.warn': 'Needs attention',
    'bureauControl.status.info': 'Information',
    'bureauControl.status.ok': 'Healthy',
    'bureauControl.status.unknown': 'Not checked',
    'bureauControl.details': 'Details', 'bureauControl.accept': 'Save to draft', 'bureauControl.editName': "Edit {name}'s name",
    'bureauControl.inlineRequired': 'Enter a value.', 'bureauControl.inlineMax': 'Use {n} characters or fewer.',
    'bureauControl.secretStored': 'Token configured', 'bureauControl.replace': 'Replace', 'bureauControl.secretKeep': 'Leave the field empty to keep the existing token.',
  },
};
registerMessages(dictionary);
