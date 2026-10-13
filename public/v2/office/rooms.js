import { loadModule } from '../build-update.js';
// Loaded with the first egg. New rooms supply a bundle, contacts and theme/weather hooks.
import { buildQuery } from '../config.js';
const load = () => loadModule(() => import('./break-room.js' + buildQuery));
export const ROOMS = {
  gym: { scene:'gym',edge:'left',arrow:'left',load,assets:{image:'assets/Office/breaks/gym.webp'},
    canvas:{w:1536,h:1024},points:{entry:{x:325,y:770},mat:{x:820,y:720},bench:{x:1330,y:558},benchFloor:{x:1160,y:700}},
    windows:[[[246,282],[491,151],[491,207],[246,333]]] },
  outdoor: { scene:'smoke',edge:'right',arrow:'right',load,assets:{image:'assets/Office/breaks/outdoor.webp'},
    canvas:{w:1536,h:1024},points:{entry:{x:520,y:440},covered:{x:565,y:480}},rainChance:.25,
    windows:[[[916,184],[963,209],[963,266],[916,242]],[[1030,257],[1078,283],[1078,328],[1030,305]]],
    shelter:[[430,210],[430,500],[690,500],[690,210]],lamp:{x:490,y:235},puddle:{x:540,y:478} },
};
