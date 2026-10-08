// Autocomplete only considers the token immediately before the caret; email addresses are ignored.
export function mentionQuery(body, caret, agents) {
  const m = /(^|[^\p{L}\p{N}_.@-])@([\p{L}\p{N}_.-]*)$/u.exec(body.slice(0, caret));
  if (!m) return null;
  const q = m[2].toLocaleLowerCase();
  return { start: caret - m[2].length - 1, end: caret, items: agents.filter((a) => a.id.toLocaleLowerCase().startsWith(q) || a.name.toLocaleLowerCase().replace(/\s+/g, '').startsWith(q)) };
}
export function insertMention(body, query, agent) {
  const token = '@' + agent.id + ' ';
  return { body: body.slice(0, query.start) + token + body.slice(query.end), caret: query.start + token.length };
}
