// Keep the server's insertion order; replies sit directly under their parent, including after pagination.
export function threadItems(items, order = 'asc') {
  const ids=new Set(items.map((c) => c.id)), children=new Map(), out=[], seen=new Set();
  for (const c of items) if (ids.has(c.replyTo)) { if (!children.has(c.replyTo)) children.set(c.replyTo,[]); children.get(c.replyTo).push(c); }
  function visit(c, reply=false) { if (seen.has(c.id)) return; seen.add(c.id); out.push({item:c,reply}); for (const child of children.get(c.id) || []) visit(child,true); }
  const roots = items.filter((c) => !ids.has(c.replyTo));
  if (order === 'desc') {
    const positions = new Map(items.map((c, i) => [c.id, i]));
    function newest(c, path = new Set()) {
      if (path.has(c.id)) return positions.get(c.id);
      const next = new Set(path).add(c.id);
      return Math.max(positions.get(c.id), ...(children.get(c.id) || []).map((child) => newest(child, next)));
    }
    roots.sort((a, b) => newest(b) - newest(a));
  }
  for (const c of roots) visit(c);
  for (const c of items) visit(c); // malformed cycles never hide a comment
  return out;
}
export function pendingSummary(items) {
  const event=items.findLast((c) => c.kind==='event' && c.text?.key==='projectThread.event.summary-requested');
  return !!event && !items.some((c) => c.replyTo===event.id) && (!event.delivery.length || event.delivery.some((d) => ['pending','working'].includes(d.status)));
}

export function retryableDelivery(comment, delivery, canMention, ownerName) {
  const mine = comment.editable || (comment.kind==='event' && comment.author.kind==='human' && comment.author.name===ownerName);
  return !!canMention && !comment.deleted && !!mine && ['failed','no-reply'].includes(delivery.status);
}
