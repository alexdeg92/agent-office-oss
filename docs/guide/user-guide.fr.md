# Utiliser Agent Office

[Read this guide in English](user-guide.en.md)

Agent Office vous permet de suivre votre agent principal, ses activités et les projets auxquels il contribue. Commencez par la phrase en tête de page : elle indique ce qui demande votre attention. Les détails viennent ensuite, avec les heures, les sources et les références en marge.

Ce guide décrit les fonctions proposées par les différentes pages. Leur disponibilité dépend de votre version, de la connexion à votre moteur d’exécution et des droits de votre instance. Une page annoncée comme à venir n’est pas encore utilisable dans cette version.

## Choisir la bonne page

| Vous voulez… | Ouvrez… |
| --- | --- |
| Voir l’activité signalée des agents | **Bureau** |
| Suivre et déplacer du travail | **Projets** |
| Retrouver un échange ou examiner une exécution | **Journaux**, le carnet des sessions |
| Consulter ou gérer les tâches planifiées | **Flux de travail** |
| Comprendre les fonctions disponibles pour l’agent | **Compétences** |
| Lire les règles d’accès et les interlocuteurs observés | **Habilitations** |
| Adresser une demande à votre agent principal | **Discuter**, lorsque l’envoi est disponible |
| Vérifier le serveur, la passerelle et la fiabilité des observations | **Santé système**, le bulletin de santé |

Sur ordinateur, utilisez la navigation latérale. Sur téléphone, la barre du bas donne accès aux pages principales ; **Plus** contient les autres pages ainsi que les réglages d’apparence et de langue.

## Lire un relevé avant d’agir

Une valeur affichée est une observation, avec une date et une source. **En direct** décrit la connexion du portail aux mises à jour ; cela ne garantit pas que chaque source soit à jour ou que chaque tâche réussisse.

**À confirmer** signifie que le portail ne dispose pas d’une observation assez récente ou complète pour affirmer l’état actuel. Il peut conserver le dernier relevé reçu. Consultez son heure, puis les sources dans Santé système. Un relevé ancien ne prouve ni que l’agent continue à travailler, ni qu’il s’est arrêté.

| Indication | Comment la lire |
| --- | --- |
| Chargement | Le relevé est attendu. Ce n’est pas un total de zéro. |
| Non renseigné, inconnu ou tiret | La valeur n’est pas disponible. |
| Aucune entrée | Le relevé reçu ne contient pas d’entrée dans le périmètre indiqué. |
| Aucun résultat avec les filtres | Retirez un filtre ou modifiez la recherche ; des entrées peuvent exister ailleurs. |
| Données conservées, en cache ou à actualiser | Lisez l’heure du dernier relevé réussi avant de vous appuyer sur la valeur. |
| Enregistrement en cours | La modification attend encore une confirmation. |

Les heures suivent le fuseau indiqué par l’instance ou la tâche. Il peut différer de celui de votre téléphone. Les couleurs aident à repérer un état ; son libellé précise ce qu’il signifie.

## Bureau : voir l’activité signalée

Le Bureau réunit la scène illustrée, les agents présents et les événements récents. La phrase d’ouverture résume l’observation principale. Le registre **Les présences** permet de retrouver un agent même lorsque son personnage est difficile à distinguer dans la scène.

Sélectionnez un personnage ou son nom dans le registre pour ouvrir ses détails. Vous pouvez y lire son état, les références disponibles et ouvrir sa session lorsque le lien est proposé. Fermez le panneau pour revenir au Bureau.

| État | Ce qu’il indique |
| --- | --- |
| Inactif, au repos | Aucune activité en cours n’est signalée pour cet agent. |
| Réfléchit | La source signale une phase de réflexion. |
| Travaille, exécute | Une activité est en cours ; son résultat n’est pas encore établi. |
| Recherche | Une phase de recherche est signalée. |
| Rédige | Une phase de rédaction est signalée. |
| Appel d’outil | L’agent utilise un outil. Consultez la session pour le résultat. |
| En attente | L’agent attend ; la cause n’est pas toujours disponible. |
| Erreur | Une erreur a été signalée. Ouvrez les détails ou la session. |
| Hors ligne | L’agent est signalé comme indisponible. Vérifiez aussi la fraîcheur du relevé. |

Une durée décrit le temps associé à l’état observé, pas le temps restant. Les déplacements et les poses rendent la scène lisible ; ils ne constituent pas une preuve qu’un travail a été livré.

Le **Carnet du bureau** rassemble les faits récents avec leur heure. Plusieurs événements semblables peuvent être regroupés. **Au prochain passage** présente les tâches à venir ; **Dernier relevé** donne le contexte de fraîcheur.

[Voir un exemple du Bureau et de sa marge](../../design/reports/office-dev-09-bureau-fr.png). Cette capture utilise des données fictives ; les noms et l’activité de votre instance seront différents.

## Personnaliser le bureau

Si **Personnaliser** est disponible, ouvrez l’éditeur depuis la scène ou le panneau d’un agent.

1. Dans **Disposition**, choisissez un élément de mobilier, puis placez-le. Les indications signalent les emplacements occupés et les passages bloqués. Certaines modifications de disposition demandent un écran plus large.
2. Dans **Personnages**, choisissez l’apparence, la couleur et les accessoires. Vous pouvez attribuer un poste ou laisser l’attribution automatique. Les règles par défaut servent aux nouveaux agents du type choisi.
3. Ajustez le nom affiché ou le rôle si les champs sont proposés. Un nom d’affichage ne renomme pas l’agent dans son moteur d’exécution.
4. Dans **Thème**, choisissez l’ambiance du bureau. Les décorations saisonnières dépendent des éléments disponibles.
5. Sélectionnez **Enregistrer** et attendez la confirmation.

Avant l’enregistrement, les changements restent un brouillon. **Annuler** et **Rétablir** permettent de revenir sur une modification. Quitter sans enregistrer abandonne le brouillon.

Les versions enregistrées permettent de reprendre une disposition antérieure : chargez la version, vérifiez-la, puis enregistrez pour la rétablir. Le retour au bureau par défaut demande également un enregistrement. Si une autre personne a modifié le bureau entre-temps, le message de conflit vous permet de recharger la version enregistrée ou de la remplacer par votre brouillon.

Si les réglages sont absents ou en lecture seule, la scène reste consultable. L’absence de **Personnaliser** n’est pas un problème d’affichage à résoudre en rechargeant plusieurs fois.

## Projets : suivre le travail

Le tableau conserve cinq étapes :

**Idée → À faire → En cours → En revue → Livré**

Ces étapes décrivent le suivi du projet. **Livré** est une étape choisie pour le projet ; elle n’est pas déduite d’une exécution réussie. **Bloqué** est un risque qui peut accompagner n’importe quelle étape.

Lisez d’abord le titre du projet, sa priorité et le point à vérifier. Dans une colonne, les projets sont ordonnés par priorité, puis par activité récente. La recherche et les filtres limitent les résultats affichés ; une vue filtrée est indiquée comme telle.

Pour déplacer un projet, utilisez **Déplacer vers** sur son entrée. Le glisser-déposer est aussi proposé sur ordinateur. Sur téléphone, **Aller à l’étape** vous aide à rejoindre une colonne. Attendez la confirmation d’enregistrement : un déplacement refusé peut ramener le projet à son étape précédente.

Ouvrez un projet pour lire son résumé et son historique. Les informations de dépôt, les personnes impliquées, les sources et les drapeaux apportent le contexte. Un résumé absent reste une information manquante. Un résumé fourni par un agent doit être lu avec sa date et confronté aux événements récents si nécessaire.

[Voir un exemple de tableau de projets](../../design/reports/frontend-08b/projets-1280-light.png). La capture illustre des projets fictifs et une disposition qui peut évoluer selon votre version.

### Comprendre les drapeaux

| Type | Usage |
| --- | --- |
| Priorité | P0 est la plus urgente, puis P1, P2 et P3. Elle aide à ordonner le travail. |
| Étiquette | Un classement choisi par l’utilisateur, par exemple « client » ou « interne ». |
| Risque | Un point à vérifier : blocage, échec d’une tâche, vérification automatisée en échec ou absence d’activité récente. |
| Fonctionnalité | Un indicateur détecté dans le code ou la configuration ; il se consulte ici. |

**Prendre en compte** un risque signifie que vous l’avez vu. Cela ne le résout pas. Un blocage manuel peut être retiré quand la situation change ; un risque automatique dépend de nouvelles observations de sa source. Les indicateurs de fonctionnalité ne se modifient pas depuis cette liste.

### Importer des projets

1. Ouvrez **Importer des projets** depuis le tableau.
2. Examinez les propositions et leurs sources : dépôts connectés, dossiers d’espace de travail ou groupes de sessions, selon votre instance.
3. Utilisez les filtres de source et de confiance. La confiance porte sur la proposition d’import, pas sur la qualité ou la priorité du projet.
4. Cochez les propositions à ajouter et vérifiez les champs modifiables proposés.
5. Lancez l’import, puis lisez le résultat : les projets créés et les propositions ignorées sont distingués.

Découvrir une proposition ne l’ajoute pas automatiquement au tableau. L’import crée un suivi dans Agent Office ; il ne déploie pas le projet. Une source déjà liée peut être ignorée pour éviter un doublon. Si la liste est vide, vérifiez les sources disponibles ou créez un projet manuellement.

## Journaux : retrouver une session

Journaux est le carnet des sessions observées. Une session rassemble des échanges et des événements liés ; une exécution correspond à une période de travail à l’intérieur de ce suivi.

Filtrez par type pour retrouver une conversation, une tâche planifiée ou le travail d’un sous-agent. Les heures, le modèle et les jetons servent de repères. Les jetons mesurent un volume traité, pas la qualité du résultat ni un prix à eux seuls. **Afficher plus** charge les sessions plus anciennes quand elles sont disponibles. Les battements, lorsqu’ils sont proposés, sont des activités périodiques de contrôle que vous pouvez inclure dans la liste.

Ouvrez une session pour lire les messages et les appels d’outil. Dépliez un appel pour voir les détails disponibles, puis distinguez le résultat de l’outil de la réponse finale de l’agent. Si une vue **Chronologie** est proposée, elle permet de lire l’ordre et les durées des événements.

Une indication de contenu tronqué ou de fenêtre partielle signifie que tout l’échange n’est pas affiché. Une session introuvable peut avoir été retirée de la source ; cela ne permet pas de conclure que son travail a échoué.

## Flux de travail : lire et gérer les tâches planifiées

Cette page présente ce qui doit s’exécuter, quand et avec quelle consigne. Commencez par les tâches qui demandent une vérification, puis consultez la prochaine date prévue et son fuseau horaire.

Ouvrez une tâche pour lire la consigne et ses résultats récents. Distinguez trois informations :

- **Activée ou désactivée** : la tâche est-elle planifiée pour fonctionner ?
- **État des exécutions** : un résultat en échec est-il signalé, ou aucune exécution n’a-t-elle encore été observée ?
- **Livraison** : le résultat a-t-il été transmis à sa destination ?

Une exécution terminée ne confirme pas à elle seule la livraison. Une tâche désactivée peut conserver un ancien échec. Le schéma d’une consigne décrit le travail prévu ; ce n’est pas une progression en direct.

Lorsque les actions sont disponibles, vous pouvez créer une tâche, modifier les champs pris en charge, activer ou désactiver sa planification, ou lancer une exécution manuelle. Vérifiez la consigne avant **Exécuter** : la demande part vers le moteur d’exécution. Désactiver une planification ne signifie pas annuler un travail déjà commencé. Certaines tâches restent consultables sans que leur consigne ou leur horaire puisse être modifié dans le portail.

Si **Supprimer** est proposé, vérifiez le nom de la tâche avant de confirmer. Supprimer sa définition est différent de désactiver temporairement sa planification.

## Compétences : comprendre ce que l’agent peut utiliser

Le répertoire des compétences explique leur rôle et leur disponibilité. Recherchez une compétence, puis ouvrez ses détails pour lire sa description, ses étapes documentées, ses sorties et ses prérequis.

**Active** décrit sa disponibilité configurée, pas une utilisation en cours. **Désactivée** indique qu’elle a été désactivée. **Indisponible** demande de consulter la raison connue et les prérequis ; si ces détails n’ont pas été reçus, la cause reste à confirmer.

La visibilité pour le modèle ou la possibilité d’utiliser une commande ne constituent pas, à elles seules, une autorisation d’accès. Les étapes décrites dans la fiche ne sont pas une trace d’exécution.

Si vous activez ou désactivez une compétence, attendez le résultat de l’enregistrement. Un message peut indiquer qu’un redémarrage reste nécessaire : la modification enregistrée n’est alors pas encore entièrement appliquée. Suivez l’indication de votre instance avant de considérer la compétence comme disponible.

## Habilitations : distinguer accès et participation

Lisez d’abord les politiques affichées pour les messages privés, les groupes et l’exécution d’outils. Consultez ensuite les agents et les interlocuteurs observés. La recherche et les filtres vous aident à retrouver une personne ou un canal.

La présence dans cette liste signifie qu’une identité ou une participation a été observée. **Elle ne prouve pas une autorisation actuelle.** De même, un canal activé n’accorde pas nécessairement l’accès à toutes les personnes qui y participent.

Ouvrez un interlocuteur pour consulter les informations disponibles, les sessions associées et les règles connues. Une identité en cours d’identification, introuvable ou un accès non renseigné reste à confirmer. Si aucun contrôle de modification n’est proposé, consultez l’administrateur pour changer la politique ; cette vue ne remplace pas sa configuration.

## Discuter : adresser une demande

Discuter sert à échanger avec votre agent principal depuis le portail. **Si la page annonce encore son arrivée, l’envoi n’est pas disponible dans cette version.** Vous pouvez consulter les échanges déjà observés dans Journaux.

Lorsque le formulaire est disponible, formulez une demande avec son objectif, les éléments utiles et le résultat attendu, puis envoyez-la. Un tour peut durer plusieurs minutes, notamment quand l’agent utilise des outils. Une indication d’exécution en cours décrit un état, pas une estimation du temps restant.

Lisez les événements et les appels d’outil lorsqu’ils sont exposés. Un appel terminé n’est pas nécessairement une réponse finale. Si les mises à jour s’interrompent, vérifiez l’état du tour et la connexion avant de renvoyer la même demande : une absence de réponse affichée ne prouve pas que l’envoi a échoué.

Pour retrouver les échanges précédents, utilisez Journaux et ouvrez la session correspondante. Un historique de fils peut aussi être proposé dans Discuter selon votre version ; son absence ne signifie pas que les sessions ont disparu.

## Santé système : lire le bulletin

Le bulletin distingue l’état du serveur de la qualité des informations reçues. Lisez la phrase d’ouverture, puis suivez le lien vers le problème ou la source qui demande une vérification.

| Partie du bulletin | Ce qu’elle vous aide à comprendre |
| --- | --- |
| Passerelle | La connexion au moteur d’exécution est-elle disponible ? |
| Processeur et mémoire | Quelles ressources sont utilisées dans le relevé ? |
| Disque | Quelle part de l’espace est occupée ? |
| Boucle d’événements | Le service traite-t-il ses événements avec le délai attendu ? Le p99 décrit le délai sous lequel se situent 99 % des observations mesurées. |
| Temps depuis le démarrage | Depuis combien de temps le serveur fonctionne-t-il sans redémarrage ? |
| Tâches et extensions | Quels états sont signalés pour les tâches planifiées et les extensions chargées ? |
| Canaux | Quels échanges sont connectés, en marche, arrêtés ou en erreur ? |
| Sources | Quand chaque source a-t-elle fourni son dernier relevé réussi ? |
| Qualité des données | Quelles observations n’ont pas pu être interprétées ou validées comme prévu ? |

Les problèmes sont distingués en **erreurs**, **avertissements** et **informations**. Ouvrez les détails pour lire la référence, les occurrences et les dates. Un problème de données peut limiter la fiabilité d’un affichage sans signifier que tout le serveur est arrêté.

Mettre un problème en sourdine réduit sa présence dans la liste habituelle ; cela ne le corrige pas. Le filtre **En sourdine** permet de le retrouver. Les erreurs ne peuvent pas être mises en sourdine. Un filtre sans résultat ne certifie pas que toutes les sources vont bien.

## Langue, apparence et lecture seule

Choisissez **FR** ou **EN** dans les réglages de l’utilisateur sur ordinateur, ou dans **Plus** sur téléphone. Le portail utilise votre choix lorsqu’il est enregistré ; sinon, il prend une langue prise en charge par votre navigateur, avec le français comme repli. Les noms de projets, les consignes et les messages conservent leur langue d’origine.

Le thème de l’interface propose **Système**, **Clair** et **Sombre**. Système suit la préférence de votre appareil. Le thème du **bureau illustré** est indépendant : son mode automatique suit les heures de jour et de nuit configurées pour l’instance. Changer l’ambiance de la pièce ne change pas l’activité réelle de l’agent.

**Lecture seule** signifie que certaines modifications sont interdites. La restriction peut concerner les actions vers l’agent, les données du portail, ou les deux. Il est donc possible de consulter des résultats, et parfois de gérer un projet, sans pouvoir lancer une tâche. Lisez le message associé à l’action : un bouton absent, désactivé ou un refus explicite précise la limite.

La lecture seule n’arrête pas les tâches déjà configurées dans le moteur d’exécution. Elle ne transforme pas non plus les données réelles en démonstration. À l’inverse, une vue marquée **Maquette** utilise des données fictives.

Si une modification est refusée, lisez le motif plutôt que de considérer le nouvel état comme enregistré. En cas de conflit, rechargez l’information puis reprenez votre changement. Pour une connexion interrompue ou un état à confirmer, commencez par Santé système et l’heure des sources.

Pour installer ou administrer une instance, consultez les guides d’[installation](install.md), de [configuration](config.md) et de [mise à niveau](upgrading.md).
