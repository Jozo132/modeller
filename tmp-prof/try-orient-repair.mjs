import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';
import { measureMeshTopology } from '../js/cad/toolkit/TopologyUtils.js';

function repair(faces) {
  const edgeMap = new Map();
  const qkey = (v) => edgeVKey(v);
  for (let fi = 0; fi < faces.length; fi++) {
    const verts = faces[fi].vertices;
    for (let i = 0; i < 3; i++) {
      const a = verts[i], b = verts[(i + 1) % 3];
      const ka = qkey(a), kb = qkey(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const fwd = ka < kb;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ fi, fwd });
    }
  }
  const adj = Array.from({ length: faces.length }, () => []);
  for (const owners of edgeMap.values()) {
    if (owners.length !== 2) continue;
    const [a, b] = owners;
    adj[a.fi].push({ to: b.fi, same: a.fwd === b.fwd });
    adj[b.fi].push({ to: a.fi, same: a.fwd === b.fwd });
  }
  const flip = new Array(faces.length).fill(null);
  for (let s = 0; s < faces.length; s++) {
    if (flip[s] != null) continue;
    flip[s] = false;
    const stack = [s];
    while (stack.length) {
      const f = stack.pop();
      for (const e of adj[f]) {
        const want = flip[f] !== e.same;
        if (flip[e.to] == null) { flip[e.to] = want; stack.push(e.to); }
      }
    }
  }
  return faces.map((face, i) => {
    if (!flip[i]) return face;
    const verts = [face.vertices[0], face.vertices[2], face.vertices[1]];
    return { ...face, vertices: verts };
  });
}
const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const faces = part.getFinalGeometry().geometry.faces;
console.log('before', measureMeshTopology(faces));
console.log('after', measureMeshTopology(repair(faces)));
