import {LABELS_EN} from '../locales/labels.en.js';
// Fallback backend labels belong to the lazy source-detail surface.
Object.assign(LABELS_EN,{
  "project.team.people.mobile":"People · {n}",
  "project.team.capability.read": "Read",
  "project.team.capability.write": "Edit",
  "project.team.capability.comments": "Comments",
  "project.team.capability.history": "History",
  "project.team.capability.repository": "Repository",
  "project.team.availability.true": "Available",
  "project.team.availability.false": "Unavailable",
  "project.team.availability.read-only": "Read only",
  "project.team.availability.read-write": "Available",
  "project.team.availability.unsupported": "Unavailable",
});
import {registerMessages} from '../messages.js';
registerMessages({fr:{
 'project.source.readonlyText':'Cette source fournit les agents et leur activité. Vous pouvez les consulter ici; aucune modification n’est disponible.',
 'project.source.count.sessions':'Sessions','project.source.count.agents':'Agents','project.source.count.activity':'Activité',
 'project.team.readonly':'Lecture seule','project.team.readonlyText':'Les tâches et les membres sont fournis par cette source. Vous pouvez les consulter ici; aucune modification n’est disponible.',
 'project.team.board':'Tableau de l’équipe','project.team.tasks':'Tâches','project.team.emptyColumn':'Aucune tâche','project.team.unassigned':'Sans responsable','project.team.owner':'Responsable :',
 'project.team.sourceAccess':'Accès de la source',
 'project.team.access':'Accès de cette source','project.team.functions':'Fonctions disponibles',
 'project.team.capability.read':'Lecture','project.team.capability.write':'Modifications','project.team.capability.comments':'Commentaires','project.team.capability.history':'Historique','project.team.capability.repository':'Dépôt',
 'project.team.availability.true':'Disponible','project.team.availability.false':'Non disponible','project.team.availability.read-only':'Lecture seule','project.team.availability.read-write':'Disponible','project.team.availability.unsupported':'Non disponible'
},en:{
 'project.source.readonlyText':'This source supplies its agents and activity. You can view them here; editing is unavailable.',
 'project.source.count.sessions':'Sessions','project.source.count.agents':'Agents','project.source.count.activity':'Activity',
 'project.team.readonly':'Read only','project.team.readonlyText':'This source supplies the tasks and members. You can view them here; editing is unavailable.',
 'project.team.board':'Team board','project.team.tasks':'Tasks','project.team.emptyColumn':'No tasks','project.team.unassigned':'Unassigned','project.team.owner':'Owner:',
 'project.team.sourceAccess':'Source access',
 'project.team.access':'Source access','project.team.functions':'Available features',
 'project.team.capability.read':'Read','project.team.capability.write':'Edit','project.team.capability.comments':'Comments','project.team.capability.history':'History','project.team.capability.repository':'Repository',
 'project.team.availability.true':'Available','project.team.availability.false':'Unavailable','project.team.availability.read-only':'Read only','project.team.availability.read-write':'Available','project.team.availability.unsupported':'Unavailable'
}});
