"""Writes demo/cubes.glb: a 3x3x3 block of coloured cubes that explodes outward
in waves, one animation clip per cube. Standard library only."""
import colorsys, json, math, struct
from pathlib import Path

N, GAP, SIZE, PUSH = 3, 1.0, 0.86, 1.6   # grid, spacing, cube edge, explode distance per unit offset
WAVE, TRAVEL = 0.35, 1.1                 # s between waves, s each cube spends moving
# One colour per wave (centre, faces, edges, corners): sage, teal, saffron, coral.
WAVE_COLOURS = ['#8ab17d', '#2a9d8f', '#e9c46a', '#e76f51']
SHADE = 0.07                             # lightness spread between cubes in a wave

# One cube, flat-shaded: 4 verts per face with that face's normal.
h = SIZE / 2
faces = [((1, 0, 0), [(h,-h,-h),(h,h,-h),(h,h,h),(h,-h,h)]), ((-1, 0, 0), [(-h,-h,h),(-h,h,h),(-h,h,-h),(-h,-h,-h)]),
         ((0, 1, 0), [(-h,h,-h),(-h,h,h),(h,h,h),(h,h,-h)]), ((0, -1, 0), [(-h,-h,h),(-h,-h,-h),(h,-h,-h),(h,-h,h)]),
         ((0, 0, 1), [(-h,-h,h),(h,-h,h),(h,h,h),(-h,h,h)]), ((0, 0, -1), [(h,-h,-h),(-h,-h,-h),(-h,h,-h),(h,h,-h)])]
pos, nrm, idx = [], [], []
for n, quad in faces:
    b = len(pos)
    pos += quad; nrm += [n] * 4
    idx += [b, b + 1, b + 2, b, b + 2, b + 3]

buf = bytearray()
views, accessors = [], []
def add(data, fmt, count, kind, ctype, target=None, mn=None, mx=None):
    while len(buf) % 4: buf.append(0)
    off = len(buf)
    buf.extend(struct.pack('<' + fmt * (len(data) // len(fmt)), *data))
    v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(buf) - off}
    if target: v['target'] = target
    views.append(v)
    a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': count, 'type': kind}
    if mn is not None: a['min'], a['max'] = mn, mx
    accessors.append(a)
    return len(accessors) - 1

flat = lambda rows: [c for r in rows for c in r]
P = add(flat(pos), 'f', 24, 'VEC3', 5126, 34962, [-h] * 3, [h] * 3)
Nm = add(flat(nrm), 'f', 24, 'VEC3', 5126, 34962)
I = add(idx, 'H', 36, 'SCALAR', 5123, 34963)

nodes, meshes, materials, animations = [], [], [], []
c = (N - 1) / 2
cells = sorted(((x, y, z) for x in range(N) for y in range(N) for z in range(N)),
               key=lambda p: (max(abs(q - c) for q in p), sum(abs(q - c) for q in p)))
rings = [int(sum(abs(q - c) for q in p)) for p in cells]
counts = {r: rings.count(r) for r in set(rings)}
seen = {r: 0 for r in counts}
for i, (x, y, z) in enumerate(cells):
    off = [(x - c) * GAP, (y - c) * GAP, (z - c) * GAP]
    ring = int(sum(abs(q - c) for q in (x, y, z)))          # 0 centre, 1 faces, 2 edges, 3 corners
    # Colour = explode wave: one hue per wave, a different shade per cube.
    base = WAVE_COLOURS[ring]
    hue, light, sat = colorsys.rgb_to_hls(*(int(base[j:j + 2], 16) / 255 for j in (1, 3, 5)))
    k = seen[ring] / max(counts[ring] - 1, 1) - 0.5       # -0.5..0.5 across this wave
    seen[ring] += 1
    r, g, b = colorsys.hls_to_rgb(hue, min(max(light + SHADE * 2 * k, 0), 1), sat)
    materials.append({'name': f'cube{i}', 'pbrMetallicRoughness': {
        'baseColorFactor': [r ** 2.2, g ** 2.2, b ** 2.2, 1], 'metallicFactor': 0, 'roughnessFactor': 0.45}})
    meshes.append({'name': f'cube{i}', 'primitives': [{'attributes': {'POSITION': P, 'NORMAL': Nm}, 'indices': I, 'material': i}]})
    nodes.append({'name': f'cube{i}', 'mesh': i, 'translation': off})
    if ring == 0:
        continue                                          # the centre stays put
    start = (ring - 1) * WAVE
    out = [o * (1 + PUSH) for o in off]
    t = add([0, start, start + TRAVEL], 'f', 3, 'SCALAR', 5126, mn=[0], mx=[start + TRAVEL])
    v = add(off + off + out, 'f', 3, 'VEC3', 5126)
    animations.append({'name': f'cube{i}', 'samplers': [{'input': t, 'output': v, 'interpolation': 'LINEAR'}],
                       'channels': [{'sampler': 0, 'target': {'node': i, 'path': 'translation'}}]})

while len(buf) % 4: buf.append(0)
doc = {'asset': {'version': '2.0', 'generator': 'cad-viewer make-demo-cubes.py'},
       'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes,
       'materials': materials, 'animations': animations, 'accessors': accessors,
       'bufferViews': views, 'buffers': [{'byteLength': len(buf)}]}
js = json.dumps(doc, separators=(',', ':')).encode()
js += b' ' * (-len(js) % 4)
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf)) \
    + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(buf), 0x004E4942) + bytes(buf)
out = Path(__file__).resolve().parent.parent / 'demo' / 'cubes.glb'
out.write_bytes(glb)
print(f'wrote {out.name}: {len(nodes)} cubes, {len(animations)} clips, {len(glb)} bytes')
