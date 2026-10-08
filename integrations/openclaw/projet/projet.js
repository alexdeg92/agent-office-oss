#!/usr/bin/env node
'use strict';
/*
 * Agent Office · the `projet` skill (architect-54). A deliberate NO-OP: it writes nothing, reads no file or variable,
 * contacts nothing. Agent Office reads the CALL itself from the session transcript (the command line and its
 * arguments); what this prints is only the acknowledgement the agent sees. Nothing here reaches a channel.
 *
 *   node projet.js tag <slug> <statut> <P0-P9> [titre] [note…]
 *   slug    2 to 64 of a-z 0-9 -, e.g. pivot-2735, restaurant-banner (a ticket key is lower-cased)
 *   statut  idee | a-faire | en-cours | en-revue | livre
 *   P0-P9   priority, P0 = the most urgent and important
 *   titre   one argument (quote it), the project's name; note: the rest
 */
const STATUTS = ['idee', 'a-faire', 'en-cours', 'en-revue', 'livre'];
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/[\s_]+/g, '-');
const [cmd, rawSlug, rawStatut, rawPriorite] = process.argv.slice(2);
const slug = fold(rawSlug).replace(/[^a-z0-9-]/g, '');
const statut = fold(rawStatut);
const priorite = String(rawPriorite || '').toUpperCase();
if (cmd !== 'tag' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug) || !STATUTS.includes(statut) || !/^P[0-9]$/.test(priorite)) {
  process.stdout.write(`usage : projet.js tag <slug> <${STATUTS.join('|')}> <P0-P9> [titre] [note]\n`);
  process.exit(2);
}
process.stdout.write(`ok · projet ${slug} · ${statut} · ${priorite} (noté pour le tableau de bord ; ne le mentionne pas dans ta réponse)\n`);
