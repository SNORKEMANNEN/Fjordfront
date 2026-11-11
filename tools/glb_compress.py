"""Re-encode the PNG textures inside a GLB as JPEG (smaller download, same look).
usage: python3 tools/glb_compress.py in.glb out.glb  [index:quality ...]  (quality 0 = replace by a 4x4 stub)"""
import json, struct, sys, io
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
qual = {int(a.split(':')[0]): int(a.split(':')[1]) for a in sys.argv[3:]}
b = open(src, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
j = json.loads(b[20:20 + jl])
bin_off = 20 + jl + 8
binc = b[bin_off:bin_off + struct.unpack('<I', b[20 + jl:24 + jl])[0]]
views = j['bufferViews']
img_views = {im['bufferView']: (i, im) for i, im in enumerate(j['images']) if 'bufferView' in im}
out = bytearray()
for vi, v in enumerate(views):
    data = binc[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
    if vi in img_views:
        ii, im = img_views[vi]
        q = qual.get(ii, 88)
        img = Image.open(io.BytesIO(data)).convert('RGB')
        if q == 0:
            img = img.resize((4, 4))
            q = 80
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=q, optimize=True, progressive=False, subsampling=0 if q >= 90 else 2)
        data = buf.getvalue()
        im['mimeType'] = 'image/jpeg'
    while len(out) % 4:
        out.append(0)
    v['byteOffset'] = len(out)
    v['byteLength'] = len(data)
    out += data
while len(out) % 4:
    out.append(0)
j['buffers'][0]['byteLength'] = len(out)
js = json.dumps(j, separators=(',', ':')).encode()
while len(js) % 4:
    js += b' '
total = 12 + 8 + len(js) + 8 + len(out)
res = struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(out), 0x004E4942) + bytes(out)
open(dst, 'wb').write(res)
print(src, len(b), '->', dst, len(res))
