// js/cad/index.js — Barrel re-exports
export { Primitive, resetPrimitiveIds, peekNextPrimitiveId } from './Primitive.js';
export { PPoint } from './Point.js';
export { PSegment } from './Segment.js';
export { PArc } from './ArcPrimitive.js';
export { PCircle } from './CirclePrimitive.js';
export { TextPrimitive } from './TextPrimitive.js';
export { DimensionPrimitive } from './DimensionPrimitive.js';
export { Scene } from './Scene.js';
export { solve } from './Solver.js';
export {
  Constraint, resetConstraintIds,
  Coincident, Distance, Fixed,
  Horizontal, Vertical,
  Parallel, Perpendicular, Angle,
  EqualLength, Length,
  RadiusConstraint, Tangent,
  OnLine, OnCircle, Midpoint,
} from './Constraint.js';
export { disconnect, union, trim, split, movePoint, moveShape } from './Operations.js';
