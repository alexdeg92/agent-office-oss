import { useRef } from '../../lib.js';

let nextId = 0;

// Instance-local IDs survive parent rerenders and keyed list moves.
export function useControlId(id, prefix = 'bu-control') {
  const generated = useRef(null);
  if (generated.current === null) generated.current = `${prefix}-${++nextId}`;
  return id || generated.current;
}
