// Office frame budget (O7): run in test/office/harness.html (e.g. through Chrome DevTools or a CDP script), with
// CPU throttling 4x for a slow machine. Ten agents (or N: change the length), two state changes every 700 ms; reports
// rAF frame times (p50/p95/p99/max), frames over 33 ms and long tasks. Not part of npm test: frame timing under the
// suite's own load would be noise. Results: design/reports/office-dev-13.md §3.
await H.until(() => window.H && H.ready);
const stage = document.getElementById('stage');
stage.style.cssText = 'width:1000px;height:640px';
const sc = new H.OfficeScene(stage, { manifest: H.manifest, layout: H.layout, assetBase: H.assetBase, theme: 'day' });
const states = ['working', 'thinking', 'writing', 'researching', 'calling', 'waiting', 'idle', 'working', 'error', 'thinking'];
const src = [{ id: 'main', role: 'main', sourceName: 'Orion', state: 'working', stateSince: Date.now() },
  ...Array.from({ length: 9 }, (_, i) => ({ id: 'subagent:s' + i, role: 'subagent', sourceName: 'Agent ' + (i + 1), state: states[i + 1], stateSince: Date.now() }))];
sc.setOccupants(H.occupants(src));
await new Promise((r) => setTimeout(r, 4000));                       // decodes, walks to desks
// churn: every 700 ms two agents change state (walks, cues, swivels, crossfades), as a busy office would
let k = 0; const churn = setInterval(() => { for (let j = 0; j < 2; j++) { const s = src[(k++ % 9) + 1]; s.state = states[(k * 3) % states.length]; s.stateSince = Date.now(); } sc.setOccupants(H.occupants(src)); }, 700);
const frames = []; let last = performance.now(); let long = 0;
const po = new PerformanceObserver((l) => { long += l.getEntries().length; }); try { po.observe({ type: 'longtask', buffered: false }); } catch {}
await new Promise((res) => { const t0 = performance.now(); const tick = (t) => { frames.push(t - last); last = t; if (t - t0 < 8000) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
clearInterval(churn);
frames.shift(); frames.sort((a, b) => a - b);
const q = (p) => +frames[Math.floor(p * (frames.length - 1))].toFixed(1);
return { agents: document.querySelectorAll('.ao-char').length, frames: frames.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), over33: frames.filter((f) => f > 33.4).length, longTasks: long, nodes: document.getElementsByTagName('*').length, imgs: document.querySelectorAll('.ao-office img').length };
