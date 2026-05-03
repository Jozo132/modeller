import './_watchdog.mjs';
import assert from 'node:assert';

import { Scene } from '../js/cad/Scene.js';

console.log('Primitive group tests');

{
  const scene = new Scene();
  const a = scene.addSegment(0, 0, 10, 0);
  const b = scene.addSegment(10, 0, 10, 10);
  const group = scene.addGroup([a, b], { name: 'Imported Path', immutable: true });

  assert.strictEqual(scene.groups.length, 1);
  assert.strictEqual(group.getChildren().length, 2);
  assert.strictEqual(scene.groupForPrimitive(a), group);

  group.translate(5, -2);
  assert.strictEqual(a.x1, 5);
  assert.strictEqual(a.y1, -2);
  assert.strictEqual(b.x2, 15);
  assert.strictEqual(b.y2, 8);
  console.log('  ✓ group translates child primitives as one unit');

  const restored = Scene.deserialize(scene.serialize());
  assert.strictEqual(restored.groups.length, 1);
  const restoredGroup = restored.groups[0];
  assert.strictEqual(restoredGroup.name, 'Imported Path');
  assert.strictEqual(restoredGroup.immutable, true);
  assert.strictEqual(restoredGroup.getChildren().length, 2);
  assert.strictEqual(restored.groupForPrimitive(restored.segments[0]), restoredGroup);
  console.log('  ✓ groups persist through scene serialization');
}

console.log('Primitive group tests passed');
