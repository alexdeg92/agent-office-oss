#!/usr/bin/env python3
"""F10 performance budget: web derivatives of the artist's illustrations.

The sources (design/assets/Illustrations/*.png, artist-owned, 240 KB to 1.4 MB each) stay untouched. This writes
design/derived/Illustrations/<name>.webp (quality 82, same pixel size, alpha kept) and manifest.json with each
source's SHA-256, so test/frontend/sync-design.test.js can tell when a source changed and its derivative is stale.
scripts/sync-design.js ships the derivatives the UI names; the UI names only .webp illustrations.

    python3 design/scripts/derive-illustrations.py           (needs Pillow with WebP)
"""
import hashlib, io, json, os, sys
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'design', 'assets', 'Illustrations')
OUT = os.path.join(ROOT, 'design', 'derived', 'Illustrations')
QUALITY = 82

def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for name in sorted(os.listdir(SRC)):
        if not name.endswith('.png') or name.endswith('-raw.png'):
            continue
        if os.path.exists(os.path.join(SRC, name[:-4] + '.webp')):
            continue   # the artist supplies this one as WebP (artist-15 state spots): ship theirs, derive nothing
        path = os.path.join(SRC, name)
        data = open(path, 'rb').read()
        im = Image.open(io.BytesIO(data))
        buf = io.BytesIO()
        im.save(buf, 'WEBP', quality=QUALITY, method=6)
        webp = name[:-4] + '.webp'
        open(os.path.join(OUT, webp), 'wb').write(buf.getvalue())
        manifest[webp] = {'source': 'design/assets/Illustrations/' + name, 'sha256': hashlib.sha256(data).hexdigest(),
                          'size': list(im.size), 'bytes': len(buf.getvalue()), 'sourceBytes': len(data)}
        print(f'{webp:32} {len(data)//1024:6} KB → {len(buf.getvalue())//1024:4} KB')
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump({'quality': QUALITY, 'files': manifest}, f, indent=1)
        f.write('\n')

if __name__ == '__main__':
    sys.exit(main())
