// Split-origin EventSource cannot carry Authorization, so each generation consumes a one-use ticket.
import * as api from './api.js';
import { config } from './config.js';

export function openSource(url) {
  const listeners = new Map();
  let source = null, closed = false, state = 0;
  const proxy = {
    get readyState() { return source?.readyState ?? state; },
    addEventListener(type, fn) {
      const list = listeners.get(type) || []; list.push(fn); listeners.set(type,list);
      if (source) source.addEventListener(type,fn);
    },
    close() { closed = true; state = 2; source?.close(); source = null; },
  };
  const parsed = new URL(url, location.href);
  const topics = (parsed.searchParams.get('topics') || '').split(',').filter(Boolean);
  api.post(`/api/v${config.apiVersion}/stream/ticket`,{topics:topics.length?topics:['system']},{apiVersion:config.apiVersion,quiet:true}).then(({data:ticket}) => {
    if (closed) return;
    source = new EventSource(ticket.streamUrl, {withCredentials:false}); state = 0;
    for (const [type, fns] of listeners) for (const fn of fns) source.addEventListener(type,fn);
    source.addEventListener('error', () => { if (closed) return; source?.close(); source = null; state = 2; for (const fn of listeners.get('error') || []) fn(new Event('error')); }, {once:true});
  }).catch(() => {
    if (closed) return; state = 2;
    for (const fn of listeners.get('error') || []) fn(new Event('error'));
  });
  return proxy;
}
