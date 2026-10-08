// Accessory contact sheet (QA for contract v2 / Batch 5b): every look × pose × accessory at 2×,
// layered exactly like the scene (accessoryLayers + poseImage). ?look=timmy|subagent/teal…&acc=<id>|all
import { indexManifest, poseImage, accessoryLayers, resolveUrl } from './assets.js';
import { config } from '../config.js';

const q = new URLSearchParams(location.search);
const dev = location.pathname.includes('/public/v2/office/');
const base = q.get('assets') ?? (dev ? '../../../design/' : config.assetBase);
const manifest = await fetch(`${dev ? base + 'office/' : config.assetBase + 'office/'}manifest.example.json`).then((r) => r.json());
const index = indexManifest(manifest);

const looks = manifest.characters.flatMap((c) => (c.variants?.length ? c.variants.map((v) => ({ id: `${c.id}/${v.id}`, ch: c, variant: v.id, label: `${c.label} · ${v.label}` })) : [{ id: c.id, ch: c, variant: null, label: c.label }]));
const lookSel = document.getElementById('look');
const accSel = document.getElementById('acc');
for (const l of looks) lookSel.add(new Option(l.label, l.id));
accSel.add(new Option('Tous', 'all'));
for (const a of manifest.accessories) accSel.add(new Option(a.label, a.id));
lookSel.value = q.get('look') ?? looks[0].id;
accSel.value = q.get('acc') ?? 'all';
document.getElementById('legacy').checked = q.get('legacy') ? q.get('legacy') !== '0' : !manifest.accessoriesV2?.complete;

function render() {
  const look = looks.find((l) => l.id === lookSel.value);
  const legacy = document.getElementById('legacy').checked;
  const dark = document.getElementById('dark').checked;
  const poses = [...new Set([...Object.keys(look.ch.poses), ...Object.keys(look.ch.variants?.find((v) => v.id === look.variant)?.poses ?? {})])];
  const accs = accSel.value === 'all' ? manifest.accessories : manifest.accessories.filter((a) => a.id === accSel.value);
  const counts = { v2: 0, v1: 0, none: 0 };
  const table = document.createElement('table');
  const head = table.insertRow();
  const th0 = document.createElement('th'); th0.className = 'row'; th0.textContent = 'Pose'; head.append(th0);
  for (const label of ['Sans accessoire', ...accs.map((a) => a.label)]) { const th = document.createElement('th'); th.textContent = label; head.append(th); }
  for (const pose of poses) {
    const body = poseImage(look.ch, look.variant, pose);
    if (body.pose !== pose) continue;   // only poses this look actually has
    const tr = table.insertRow();
    const th = document.createElement('th'); th.className = 'row'; th.textContent = pose; tr.append(th);
    for (const a of [null, ...accs]) {
      const td = tr.insertCell();
      const cell = document.createElement('div');
      cell.className = 'cell' + (dark ? ' dark' : '');
      const layers = a ? accessoryLayers(index, look.ch.id, [a.id], pose, look.variant, { legacy }) : { back: [], front: [] };
      const firstBody = body.frames ? body.frames[0] : body.path;
      for (const p of [...layers.back.map((l) => l.path), firstBody, ...layers.front.map((l) => l.path)]) {
        const img = document.createElement('img');
        img.src = resolveUrl(p, base);
        img.alt = '';
        cell.append(img);
      }
      const tag = document.createElement('span');
      if (!a) { tag.className = 'tag base'; tag.textContent = body.frames ? `${body.frames.length} images` : 'base'; }
      else {
        const kind = layers.back.length + layers.front.length === 0 ? 'none' : layers.front.some((l) => l.legacy) ? 'v1' : 'v2';
        counts[kind]++;
        tag.className = `tag ${kind}`;
        tag.textContent = kind === 'none' ? 'absent' : kind;
      }
      cell.append(tag);
      td.append(cell);
    }
  }
  document.getElementById('sheet').replaceChildren(table);
  document.getElementById('summary').textContent = `${look.label} : ${counts.v2} en v2, ${counts.v1} en secours v1, ${counts.none} absents.`;
  window.contactCounts = counts;
}
for (const id of ['look', 'acc', 'legacy', 'dark']) document.getElementById(id).addEventListener('change', render);
render();
const cov = manifest.accessoriesV2;
if (cov) document.getElementById('coverage').textContent = `Lot 5b : ${cov.covered} combinaisons sur ${cov.total} livrées en deux couches${cov.complete ? ' (complet : secours v1 désactivé par défaut)' : ''}.`;
