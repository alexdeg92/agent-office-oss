import * as fmt from '../fmt.js';

export const locale = () => (String(fmt.LOCALE).toLowerCase().startsWith('en') ? 'en' : 'fr');

const fr = {
  'team.office.label': 'Équipe et présences des orchestrateurs', 'team.office.eyebrow': 'L’équipe dans le bureau',
  'team.office.defaultName': 'Équipe Agent Office',
  'team.herdr.enableGrouping': 'Activez herdr pour regrouper les équipes',
  'team.source.team': 'Équipe', 'team.source.herdr': 'Présences Herdr',
  'team.current': 'À jour', 'team.stale': 'En retard', 'team.lastObserved': 'Dernier état', 'team.cached': 'La connexion est interrompue ; le dernier relevé reste affiché.',
  'team.members.heading': 'Membres · {count}', 'team.members.label': 'Membres de l’équipe', 'team.members.empty': 'Aucun membre dans cette équipe.',
  'team.role.lead': 'Responsable', 'team.role.member': 'Membre', 'team.role.unknown': 'Rôle inconnu',
  'team.member.inactive': 'Inactif', 'team.member.liveStatus': '{runtime} · {status}', 'team.member.spawnedBy': 'Sous-agent de {name}', 'team.member.sessionUnknown': 'Session inconnue',
  'team.host.observation': 'Présence Herdr · {role} · {status}', 'team.host.role.primary': 'agent principal', 'team.host.role.delegate': 'délégué', 'team.host.role.unknown': 'rôle inconnu',
  'team.host.status.working': 'en activité', 'team.host.status.blocked': 'bloqué', 'team.host.status.done': 'terminé', 'team.host.status.idle': 'inactif', 'team.host.status.unknown': 'état inconnu',
  'team.host.heading': 'Présences Herdr · {count}', 'team.host.label': 'Présences observées par Herdr', 'team.host.readOnly': 'Observation en lecture seule',
  'team.host.empty': 'Aucune présence Herdr observée.', 'team.host.staleEmpty': 'Aucune présence récente à afficher.',
  'team.host.unnamedCount': 'Observation sans nom · {count}', 'team.host.anonymousStatus': '{status} · nom non fourni', 'team.host.unnamed': 'Observation sans nom',
  'team.host.working': 'En activité', 'team.host.blocked': 'Bloqué', 'team.host.done': 'Terminé', 'team.host.idle': 'Inactif', 'team.host.unknown': 'État inconnu',
  'team.runtime.other': 'Runtime', 'team.runtime.unknown': 'Runtime inconnu', 'team.runtime.claudeCode': 'Claude Code', 'team.runtime.codex': 'Codex',
  'team.runtime.transport.acp': 'ACP', 'team.runtime.transport.nativeTask': 'Tâche native',
  'team.member.status.active': 'Actif', 'team.member.status.inactive': 'Inactif', 'team.member.status.unknown': 'État inconnu', 'team.member.unnamed': 'Membre sans nom',
  'team.board.heading': 'Tableau · {count} tâches', 'team.board.open': 'Voir le tableau · {count}', 'team.board.empty': 'Aucune tâche dans ce tableau.',
  'team.board.partial': '{count} entrée(s) d’équipe n’ont pas pu être lues ; les autres restent disponibles.',
  'team.task.open': 'À faire', 'team.task.claimed': 'Attribué', 'team.task.working': 'En cours', 'team.task.review': 'À réviser', 'team.task.done': 'Terminé', 'team.task.blocked': 'Bloqué', 'team.task.unknown': 'Autre état',
  'team.task.doneCount': 'Terminées · {count}', 'team.task.unassigned': 'Sans responsable', 'team.task.priority': 'P{priority}',
  'team.task.state': 'État : {state}', 'team.task.owner': 'Responsable : {owner}', 'team.task.reviewers': 'Relecteurs : {reviewers}', 'team.task.updated': 'Dernière mise à jour :',
  'team.review.go': 'Approuvé', 'team.review.noGo': 'À corriger', 'team.review.pending': 'En attente', 'team.review.unknown': 'Revue inconnue', 'team.review.none': 'Aucune revue', 'team.review.reviewerUnknown': 'Relecteur inconnu',
  'team.loading': 'Chargement de {source}…', 'team.unavailable': 'Source indisponible · {source}', 'team.failed': 'Impossible de charger · {source}', 'team.retry': 'Réessayer',
};
const en = {
  'team.office.label': 'Team and orchestrator presence', 'team.office.eyebrow': 'The team in the office', 'team.office.defaultName': 'Agent Office team',
  'team.herdr.enableGrouping': 'Enable herdr to group teams',
  'team.source.team': 'Team', 'team.source.herdr': 'Herdr presence',
  'team.current': 'Up to date', 'team.stale': 'Stale', 'team.lastObserved': 'Last observed', 'team.cached': 'The connection is interrupted; the last snapshot remains visible.',
  'team.members.heading': 'Members · {count}', 'team.members.label': 'Team members', 'team.members.empty': 'No members in this team.',
  'team.role.lead': 'Lead', 'team.role.member': 'Member', 'team.role.unknown': 'Unknown role',
  'team.member.inactive': 'Inactive', 'team.member.liveStatus': '{runtime} · {status}', 'team.member.spawnedBy': 'Sub-agent of {name}', 'team.member.sessionUnknown': 'Session unknown',
  'team.host.observation': 'Herdr presence · {role} · {status}', 'team.host.role.primary': 'primary agent', 'team.host.role.delegate': 'delegate', 'team.host.role.unknown': 'unknown role',
  'team.host.status.working': 'working', 'team.host.status.blocked': 'blocked', 'team.host.status.done': 'done', 'team.host.status.idle': 'idle', 'team.host.status.unknown': 'unknown status',
  'team.host.heading': 'Herdr presence · {count}', 'team.host.label': 'Presence observed by Herdr', 'team.host.readOnly': 'Read-only observation',
  'team.host.empty': 'No Herdr presence observed.', 'team.host.staleEmpty': 'No recent presence to show.',
  'team.host.unnamedCount': 'Unnamed observation · {count}', 'team.host.anonymousStatus': '{status} · no name provided', 'team.host.unnamed': 'Unnamed observation',
  'team.host.working': 'Working', 'team.host.blocked': 'Blocked', 'team.host.done': 'Done', 'team.host.idle': 'Idle', 'team.host.unknown': 'Unknown status',
  'team.runtime.other': 'Runtime', 'team.runtime.unknown': 'Unknown runtime', 'team.runtime.claudeCode': 'Claude Code', 'team.runtime.codex': 'Codex',
  'team.runtime.transport.acp': 'ACP', 'team.runtime.transport.nativeTask': 'Native task',
  'team.member.status.active': 'Active', 'team.member.status.inactive': 'Inactive', 'team.member.status.unknown': 'Unknown status', 'team.member.unnamed': 'Unnamed member',
  'team.board.heading': 'Board · {count} tasks', 'team.board.open': 'View board · {count}', 'team.board.empty': 'No tasks on this board.',
  'team.board.partial': '{count} team record(s) could not be read; the remaining entries are available.',
  'team.task.open': 'Open', 'team.task.claimed': 'Claimed', 'team.task.working': 'In progress', 'team.task.review': 'In review', 'team.task.done': 'Done', 'team.task.blocked': 'Blocked', 'team.task.unknown': 'Other state',
  'team.task.doneCount': 'Done · {count}', 'team.task.unassigned': 'Unassigned', 'team.task.priority': 'P{priority}',
  'team.task.state': 'State: {state}', 'team.task.owner': 'Owner: {owner}', 'team.task.reviewers': 'Reviewers: {reviewers}', 'team.task.updated': 'Updated:',
  'team.review.go': 'Approved', 'team.review.noGo': 'Changes needed', 'team.review.pending': 'Pending', 'team.review.unknown': 'Unknown review', 'team.review.none': 'No review', 'team.review.reviewerUnknown': 'Unknown reviewer',
  'team.loading': 'Loading {source}…', 'team.unavailable': 'Source unavailable · {source}', 'team.failed': 'Could not load · {source}', 'team.retry': 'Retry',
};

export function s(key, params = {}, loc = locale()) {
  const template = (loc === 'en' ? en : fr)[key] ?? fr[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
