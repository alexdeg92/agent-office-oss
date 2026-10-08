// Count comments and replies, excluding event/system lines and deleted messages, across the thread's older pages.
export async function countDiscussion(first, loadOlder) {
  const items = new Map(), cursors = new Set();
  let page = first;
  for (;;) {
    for (const item of page.items) items.set(item.id, item);
    if (!page.nextCursor) break;
    if (cursors.has(page.nextCursor)) throw new Error('Repeated comment cursor');
    cursors.add(page.nextCursor);
    page = await loadOlder(page.nextCursor);
  }
  return [...items.values()].filter((c) => c.kind === 'comment' && !c.deleted).length;
}
