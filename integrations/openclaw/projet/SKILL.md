---
name: projet
description: Étiquette projet pour Agent Office. Signale, sans rien envoyer à personne, le projet sur lequel tu travailles, son statut et sa priorité.
---
<!-- agent-office:projet -->

# projet

Métadonnée pour le tableau de bord Agent Office. L’outil ne fait rien : seul l’appel compte, et il reste dans l’historique de la session. Il n’est jamais envoyé à qui que ce soit.

```
node {baseDir}/projet.js tag <slug> <statut> <P0-P9> ["titre"] [note]
```

- `slug` : court, en minuscules avec des tirets, stable (`pivot-2735`, `menu-builder`). Reprends toujours le même pour un même projet, y compris dans une autre conversation.
- `statut` : `idee`, `a-faire`, `en-cours`, `en-revue` ou `livre`. Travail remis au demandeur : `en-revue` ; `livre` seulement quand il confirme que c’est terminé ou accepté ; changements demandés : `en-cours` (ou `a-faire`).
- `P0-P9` : la priorité, selon l’urgence et l’impact (P0 = le plus urgent et important, P9 = le moins).
- `"titre"` : le nom du projet, entre guillemets (facultatif, surtout au premier appel). `note` : facultative.

Ne mentionne jamais l’étiquette dans tes réponses.
