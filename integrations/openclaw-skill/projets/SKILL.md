---
name: projets
description: "Met à jour une carte du tableau Projets d’Agent Office pour Timmy : déplacer, réordonner (changer de colonne), étiquette, résumé, note d’historique. Ne pas l’utiliser pour archiver, importer, les personnes, Bloqué, ou toute autre zone du portail."
metadata: { "openclaw": { "emoji": "📋", "requires": { "bins": ["node"], "env": ["AGENT_OFFICE_TOKEN"] } } }
---

# Projets

Brouillon, pas installé. Le script est `integrations/openclaw-skill/projets/scripts/projets.js`. Il appelle `/api/v2` avec `Authorization: Bearer` lu dans `AGENT_OFFICE_TOKEN`. Il ne lit aucun fichier de jeton et n’écrit rien dans `~/.openclaw`.

```bash
node scripts/projets.js status <id> <révision> <statut>
node scripts/projets.js reorder <id> <révision> <statut>
node scripts/projets.js label <id> <révision> <étiquette>
node scripts/projets.js summary <id> <révision> <résumé>
node scripts/projets.js history <id> <révision> agent-action action=commented note="Terminé"
```

Statuts : `idea`, `todo`, `in-progress`, `in-review`, `shipped`. L’acteur est toujours Timmy ; le script n’envoie pas d’acteur.

## Quand l'utiliser

- Owner demande de déplacer une carte de colonne.
- Owner demande une étiquette sur un projet.
- Owner demande de corriger le résumé d’un projet.
- Il faut noter une action déjà faite (`agent-action`) ou un événement d’activité connu (`commit`, `flow-run`, `cron-run`, `session`), avec la révision vue sur la carte.

## Quand ne pas l'utiliser

- Archiver, restaurer, renommer, changer la priorité, Bloqué, les risques, les personnes, l’import, les candidats.
- Lire les journaux, la santé, les compétences, la passerelle, le bureau ou le clavardage.
- Lire ou écrire `~/.openclaw`, `.env`, ou un fichier de secret.
- Deviner une position dans la colonne : `reorder` change seulement le statut. Un index est refusé.
- Inventer une révision. Sans `expectedRevision`, ne rien envoyer.

## Jeton

`AGENT_OFFICE_TOKEN` vient de l’environnement du skill. Le fichier proposé est `~/.config/agent-office-timmy.token` (mode 600), hors du dépôt. Ne jamais l’afficher, le coller dans une note, ni le mettre dans l’URL.
