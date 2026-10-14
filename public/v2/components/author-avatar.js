// Render the backend-supplied Office appearance; identity selection stays in the VM.
import { html, useEffect, useState } from '../lib.js';
import { config } from '../config.js';
import { indexManifest } from '../office/assets.js';
import { avatarSource, CharacterAvatar } from '../office/avatar.js';

const manifests = new Map();
function portraitIndex(base) {
  if (!manifests.has(base)) {
    const pending = fetch(base + 'office/manifest.example.json')
      .then(response => {
        if (!response.ok) throw Error('Portrait registry unavailable');
        return response.json();
      }).then(indexManifest);
    manifests.set(base, pending);
    pending.catch(() => {
      if (manifests.get(base) === pending) manifests.delete(base);
    });
  }
  return manifests.get(base);
}

export function AuthorAvatar({ look, state }) {
  const base = config.assetBase;
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    if (!look) return;
    let live = true;
    portraitIndex(base).then(index => {
      if (live) setLoaded({ base, index });
    }, () => { /* Shared avatar keeps its loading/error icon fallback. */ });
    return () => { live = false; };
  }, [base, !!look]);
  const source = look && loaded?.base === base ? avatarSource(loaded.index, look, base) : null;
  return html`<${CharacterAvatar} source=${source} state=${state} />`;
}
