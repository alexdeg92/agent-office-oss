// Responsive geometry only; board membership/order/counts come from v3.
import {useState,useEffect} from '../lib.js';
export function useSmallProjects() {
  const [small,setSmall]=useState(() => matchMedia('(max-width: 600px)').matches);
  useEffect(() => {const m=matchMedia('(max-width: 600px)'),change=() => setSmall(m.matches);m.addEventListener('change',change);return () => m.removeEventListener('change',change);},[]);
  return small;
}
