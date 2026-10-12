// Historical agent inventory is retained for layout editing and Journaux, but
// it never creates an occupant: only live session evidence or a current host
// presence can put an agent on stage.
export function seenOccupants() { return []; }

