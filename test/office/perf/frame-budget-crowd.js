// Bureau frame budget at 30 agents (O9): run in public/v2/office/bureau-dev.html?scenario=foule (the real page: office
// plus two annex rooms), e.g. through a CDP script, at CPU 1x and 4x. The mock's tick changes about 3 agents every
// 700 ms (walks, cues, crossfades). Reports rAF frame times and long tasks. Not part of npm test (timing under the
// suite's load is noise). Results: design/reports/office-dev-16.md.
const B = window.officeBench;
await B.until(() => document.querySelectorAll('.ao-char').length >= 30);
await new Promise((r) => setTimeout(r, 5000));
const churn = setInterval(async () => { B.om.tick(); await B.publish('office'); }, 700);
const frames = []; let last = performance.now(); let long = 0;
const po = new PerformanceObserver((l) => { long += l.getEntries().length; }); try { po.observe({ type: 'longtask' }); } catch {}
await new Promise((res) => { const t0 = performance.now(); const tick = (t) => { frames.push(t - last); last = t; if (t - t0 < 8000) requestAnimationFrame(tick); else res(); }; requestAnimationFrame(tick); });
clearInterval(churn); frames.shift(); frames.sort((a, b) => a - b);
const q = (p) => +frames[Math.floor(p * (frames.length - 1))].toFixed(1);
return { chars: document.querySelectorAll('.ao-char').length, scenes: document.querySelectorAll('.ao-office').length, frames: frames.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), over33: frames.filter((f) => f > 33.4).length, longTasks: long, nodes: document.getElementsByTagName('*').length };
