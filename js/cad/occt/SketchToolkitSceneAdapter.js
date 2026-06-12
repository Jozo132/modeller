import { getAllVariables, resolveAllVariables, resolveValue } from '../Constraint.js';
import { buildSmartSegmentAngleInfo } from './SketchToolkitSmartDimensions.js';
import { getSharedSketchToolkitSync } from './SketchToolkitLoader.js';

const DEFAULT_PLANE = Object.freeze({
  origin: [0, 0, 0],
  normal: [0, 0, 1],
  xAxis: [1, 0, 0],
  yAxis: [0, 1, 0],
});

const DEFAULT_SOLVE_OPTIONS = Object.freeze({
  algorithm: 'lm',
  maxIterations: 64,
  residualTolerance: 1e-8,
  stepTolerance: 1e-10,
});

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildResolvedParameterMap() {
  const resolved = resolveAllVariables(getAllVariables());
  const out = {};
  for (const [name, value] of resolved.entries()) {
    if (Number.isFinite(value)) {
      out[name] = value;
    }
  }
  return out;
}

function normalizeScalarSource(value, parameters) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Sketch toolkit adapter received a non-finite numeric constraint value');
    }
    return value;
  }

  if (typeof value !== 'string') {
    throw new Error(`Sketch toolkit adapter expected a numeric or string scalar source, got ${typeof value}`);
  }

  const text = value.trim();
  if (!text) {
    throw new Error('Sketch toolkit adapter received an empty string scalar source');
  }

  if (IDENTIFIER_RE.test(text) && Object.prototype.hasOwnProperty.call(parameters, text)) {
    return text;
  }

  const resolved = resolveValue(text);
  if (!Number.isFinite(resolved)) {
    throw new Error(`Sketch toolkit adapter could not resolve scalar source: ${text}`);
  }
  return resolved;
}

function buildFixedPointTargets(scene) {
  const targets = new Map();
  for (const constraint of scene?.constraints || []) {
    if (constraint?.type !== 'fixed' || !constraint?.pt) continue;
    targets.set(constraint.pt, {
      x: Number(constraint.fx),
      y: Number(constraint.fy),
    });
  }
  return targets;
}

function isSegmentLikeShape(shape) {
  return !!(shape?.p1 && shape?.p2);
}

function isArcLikeShape(shape) {
  return !!(shape?.center && shape?.startPoint && shape?.endPoint && Number.isFinite(Number(shape?.radius)));
}

function isCurveLikeShape(shape) {
  return !!(shape?.center && Number.isFinite(Number(shape?.radius)));
}

function isCircleLikeShape(shape) {
  return isCurveLikeShape(shape) && !isArcLikeShape(shape);
}

function isPointLikeShape(shape) {
  return !!shape && shape.type === 'point';
}

function isSupportedConstraintType(type) {
  return type === 'fixed'
    || type === 'coincident'
    || type === 'distance'
    || type === 'horizontal'
    || type === 'vertical'
    || type === 'parallel'
    || type === 'perpendicular'
    || type === 'angle'
    || type === 'equal_length'
    || type === 'length'
    || type === 'on_line'
    || type === 'on_circle'
    || type === 'radius'
    || type === 'tangent';
}

function isSupportedDimensionConstraint(constraint) {
  if (constraint?.type !== 'dimension') {
    return false;
  }

  if (constraint?.isConstraint !== true) {
    return true;
  }

  const sourceA = constraint.sourceA;
  const sourceB = constraint.sourceB || null;
  if (!sourceA) {
    return false;
  }

  switch (constraint.dimType) {
    case 'distance':
      return (isPointLikeShape(sourceA) && isPointLikeShape(sourceB))
        || (isSegmentLikeShape(sourceA) && !sourceB)
        || (isPointLikeShape(sourceA) && isSegmentLikeShape(sourceB))
        || (isSegmentLikeShape(sourceA) && isPointLikeShape(sourceB))
        || (isCurveLikeShape(sourceA) && isPointLikeShape(sourceB))
        || (isPointLikeShape(sourceA) && isCurveLikeShape(sourceB))
        || (isCurveLikeShape(sourceA) && isCurveLikeShape(sourceB))
        || (isSegmentLikeShape(sourceA) && isSegmentLikeShape(sourceB))
        || (isSegmentLikeShape(sourceA) && isCurveLikeShape(sourceB))
        || (isCurveLikeShape(sourceA) && isSegmentLikeShape(sourceB));
    case 'dx':
    case 'dy':
      return (isPointLikeShape(sourceA) && isPointLikeShape(sourceB))
        || (isSegmentLikeShape(sourceA) && !sourceB);
    case 'angle':
      return isSegmentLikeShape(sourceA) && isSegmentLikeShape(sourceB);
    case 'radius':
    case 'diameter':
      return isCurveLikeShape(sourceA) && !sourceB;
    default:
      return false;
  }
}

function isSupportedConstraint(constraint) {
  if (constraint?.type === 'dimension') {
    return isSupportedDimensionConstraint(constraint);
  }
  return isSupportedConstraintType(constraint?.type);
}

function describeConstraintType(constraint) {
  if (constraint?.type === 'dimension') {
    return `dimension:${String(constraint?.dimType || 'unknown')}`;
  }
  return String(constraint?.type || 'unknown');
}

function getDimensionScalarSource(constraint) {
  if (constraint?.formula != null) {
    return constraint.formula;
  }

  const measured = Number(constraint?.value);
  if (Number.isFinite(measured)) {
    return measured;
  }

  throw new Error('Sketch toolkit adapter could not resolve a target value for a driving smart dimension');
}

function normalizeScaledScalarSource(value, parameters, scale = 1) {
  const normalized = normalizeScalarSource(value, parameters);
  if (scale === 1) {
    return normalized;
  }
  if (typeof normalized === 'number') {
    return normalized * scale;
  }
  const parameterValue = parameters[normalized];
  if (!Number.isFinite(parameterValue)) {
    throw new Error(`Sketch toolkit adapter could not resolve scaled scalar source: ${normalized}`);
  }
  return parameterValue * scale;
}

export function collectUnsupportedSceneConstraints(scene) {
  const unsupported = [];
  for (const constraint of scene?.constraints || []) {
    if (!isSupportedConstraint(constraint)) {
      unsupported.push({
        id: Number.isFinite(constraint?.id) ? constraint.id : null,
        type: describeConstraintType(constraint),
      });
    }
  }
  return unsupported;
}

function normalizeToolkitAndOptions(toolkitOrOptions, maybeOptions) {
  if (toolkitOrOptions && typeof toolkitOrOptions.createSketch === 'function') {
    return {
      toolkit: toolkitOrOptions,
      options: maybeOptions || {},
    };
  }

  return {
    toolkit: getSharedSketchToolkitSync(),
    options: toolkitOrOptions || {},
  };
}

function applyDrivenDimensionMeasurements(dimensions, drivenDimensions) {
  const dimensionById = new Map();

  for (const dimension of dimensions || []) {
    if (!dimension) {
      continue;
    }

    if (typeof dimension.clearDrivenMeasurement === 'function') {
      dimension.clearDrivenMeasurement();
    }

    if (Number.isFinite(dimension.id)) {
      dimensionById.set(String(dimension.id), dimension);
    }
  }

  for (const entry of drivenDimensions || []) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name.startsWith('dimension:')) {
      continue;
    }

    const dimensionId = name.slice('dimension:'.length).trim();
    if (!dimensionId) {
      continue;
    }

    const dimension = dimensionById.get(dimensionId);
    if (!dimension || typeof dimension.setDrivenMeasurement !== 'function') {
      continue;
    }

    dimension.setDrivenMeasurement(entry.value, {
      kind: entry.kind,
      name: entry.name,
      drivingState: entry.drivingState,
    });
  }
}

export function solveSceneWithSketchToolkit(scene, toolkitOrOptions, maybeOptions) {
  const { toolkit, options } = normalizeToolkitAndOptions(toolkitOrOptions, maybeOptions);
  if (!scene || typeof scene !== 'object') {
    throw new Error('Sketch toolkit adapter requires a Scene-like object');
  }
  if (!toolkit || typeof toolkit.createSketch !== 'function') {
    throw new Error('Sketch toolkit adapter requires a loaded sketch toolkit instance');
  }

  const unsupportedConstraints = collectUnsupportedSceneConstraints(scene);
  if (unsupportedConstraints.length > 0 && options.allowPartial !== true) {
    const unsupportedTypes = [...new Set(unsupportedConstraints.map((item) => item.type))].join(', ');
    throw new Error(`Sketch toolkit adapter does not yet support: ${unsupportedTypes}`);
  }

  const parameters = buildResolvedParameterMap();
  const fixedPointTargets = buildFixedPointTargets(scene);
  const pointToEntity = new Map();
  const entityToPoint = new Map();
  const segmentToEntity = new Map();
  const curveToEntity = new Map();
  const entityToCurve = new Map();
  const midpointEntityCache = new Map();
  const smartAngleHelperCache = new Map();
  const sketch = toolkit.createSketch({
    name: options.name || 'modeller-scene',
    plane: options.plane || DEFAULT_PLANE,
  });

  const ensurePointEntity = (point) => {
    if (pointToEntity.has(point)) return pointToEntity.get(point);

    const fixedTarget = fixedPointTargets.get(point);
    const entityId = toolkit.addPoint(sketch, {
      x: fixedTarget ? fixedTarget.x : Number(point?.x) || 0,
      y: fixedTarget ? fixedTarget.y : Number(point?.y) || 0,
      fixed: (point?.fixed === true && !fixedTarget) || point?._isReference === true,
    });

    pointToEntity.set(point, entityId);
    entityToPoint.set(entityId, point);
    return entityId;
  };

  const ensureCircleEntity = (shape) => {
    if (curveToEntity.has(shape)) return curveToEntity.get(shape);

    if (!isCircleLikeShape(shape)) {
      throw new Error('Sketch toolkit adapter requires circle-like objects with a center point and a finite radius');
    }

    const radius = Number(shape.radius);
    const entityId = toolkit.addCircle(sketch, {
      center: ensurePointEntity(shape.center),
      radius,
      construction: shape.construction === true,
    });

    curveToEntity.set(shape, entityId);
    entityToCurve.set(entityId, shape);
    return entityId;
  };

  const ensureArcEntity = (shape) => {
    if (curveToEntity.has(shape)) return curveToEntity.get(shape);

    if (!isArcLikeShape(shape)) {
      throw new Error('Sketch toolkit adapter requires arc-like objects with a center point, endpoints, and a finite radius');
    }

    const spec = {
      center: ensurePointEntity(shape.center),
      radius: Number(shape.radius),
      startPoint: ensurePointEntity(shape.startPoint),
      endPoint: ensurePointEntity(shape.endPoint),
      startRadians: Number(shape.startAngle) || 0,
      sweepRadians: Number(shape.sweepAngle) || 0,
      construction: shape.construction === true,
    };

    const entityId = typeof toolkit.addArc === 'function'
      ? toolkit.addArc(sketch, spec)
      : toolkit.addEntity(sketch, { kind: 'arc', ...spec });

    curveToEntity.set(shape, entityId);
    entityToCurve.set(entityId, shape);
    return entityId;
  };

  const ensureCurveEntity = (shape) => {
    if (isArcLikeShape(shape)) return ensureArcEntity(shape);
    return ensureCircleEntity(shape);
  };

  const ensureSegmentEntity = (segment) => {
    if (segmentToEntity.has(segment)) return segmentToEntity.get(segment);

    if (!segment?.p1 || !segment?.p2) {
      throw new Error('Sketch toolkit adapter requires segment-like objects with p1 and p2');
    }

    const entityId = toolkit.addLineSegment(sketch, {
      start: ensurePointEntity(segment.p1),
      end: ensurePointEntity(segment.p2),
      construction: segment.construction === true,
    });

    segmentToEntity.set(segment, entityId);
    return entityId;
  };

  const addTransientPointEntity = (x, y) => toolkit.addPoint(sketch, {
    x: Number(x) || 0,
    y: Number(y) || 0,
    fixed: false,
  });

  const addTransientSegmentEntity = (startEntity, endEntity) => toolkit.addLineSegment(sketch, {
    start: startEntity,
    end: endEntity,
    construction: true,
  });

  const ensureSegmentMidpointEntity = (segment) => {
    if (midpointEntityCache.has(segment)) {
      return midpointEntityCache.get(segment);
    }

    if (!isSegmentLikeShape(segment)) {
      throw new Error('Sketch toolkit adapter can only build midpoint helpers for segment-like shapes');
    }

    const midpointEntity = addTransientPointEntity(
      (Number(segment.p1?.x) + Number(segment.p2?.x)) / 2,
      (Number(segment.p1?.y) + Number(segment.p2?.y)) / 2,
    );
    const startEntity = ensurePointEntity(segment.p1);
    const endEntity = ensurePointEntity(segment.p2);
    const segmentEntity = ensureSegmentEntity(segment);
    const helperA = addTransientSegmentEntity(midpointEntity, startEntity);
    const helperB = addTransientSegmentEntity(midpointEntity, endEntity);

    toolkit.addConstraint(sketch, {
      kind: 'distance-point-line',
      point: midpointEntity,
      line: segmentEntity,
      value: 0,
    });
    toolkit.addConstraint(sketch, {
      kind: 'equal-length',
      entityA: helperA,
      entityB: helperB,
    });

    midpointEntityCache.set(segment, midpointEntity);
    return midpointEntity;
  };

  const ensureSmartAngleHelperEntities = (constraint) => {
    if (smartAngleHelperCache.has(constraint)) {
      return smartAngleHelperCache.get(constraint);
    }

    const sourceA = constraint?.sourceA;
    const sourceB = constraint?.sourceB;
    if (!isSegmentLikeShape(sourceA) || !isSegmentLikeShape(sourceB)) {
      throw new Error('Sketch toolkit adapter can only build smart angle helpers for segment-like shapes');
    }

    const info = buildSmartSegmentAngleInfo(sourceA, sourceB, {
      endpointAKey: constraint.angleEndpointAKey,
      endpointBKey: constraint.angleEndpointBKey,
    });

    if (!info.angleEndpointAKey || !info.angleEndpointBKey) {
      const fallback = {
        lineA: ensureSegmentEntity(sourceA),
        lineB: ensureSegmentEntity(sourceB),
      };
      smartAngleHelperCache.set(constraint, fallback);
      return fallback;
    }

    const vertexEntity = addTransientPointEntity(info.vx, info.vy);
    const sourceALine = ensureSegmentEntity(sourceA);
    const sourceBLine = ensureSegmentEntity(sourceB);
    const helperLineA = addTransientSegmentEntity(vertexEntity, ensurePointEntity(sourceA[info.angleEndpointAKey]));
    const helperLineB = addTransientSegmentEntity(vertexEntity, ensurePointEntity(sourceB[info.angleEndpointBKey]));

    toolkit.addConstraint(sketch, {
      kind: 'distance-point-line',
      point: vertexEntity,
      line: sourceALine,
      value: 0,
    });
    toolkit.addConstraint(sketch, {
      kind: 'distance-point-line',
      point: vertexEntity,
      line: sourceBLine,
      value: 0,
    });

    const helper = { lineA: helperLineA, lineB: helperLineB };
    smartAngleHelperCache.set(constraint, helper);
    return helper;
  };

  const addSmartDimensionConstraint = (constraint) => {
    if (!constraint?.sourceA) {
      return;
    }

    const sourceA = constraint.sourceA;
    const sourceB = constraint.sourceB || null;
    const name = `dimension:${constraint.id}`;

    if (constraint?.isConstraint !== true) {
      switch (constraint.dimType) {
        case 'distance': {
          if (isPointLikeShape(sourceA) && isPointLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-point',
              pointA: ensurePointEntity(sourceA),
              pointB: ensurePointEntity(sourceB),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isSegmentLikeShape(sourceA) && !sourceB) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-point',
              pointA: ensurePointEntity(sourceA.p1),
              pointB: ensurePointEntity(sourceA.p2),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isPointLikeShape(sourceA) && isSegmentLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-line',
              point: ensurePointEntity(sourceA),
              line: ensureSegmentEntity(sourceB),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isSegmentLikeShape(sourceA) && isPointLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-line',
              point: ensurePointEntity(sourceB),
              line: ensureSegmentEntity(sourceA),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isCurveLikeShape(sourceA) && isPointLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-point',
              pointA: ensurePointEntity(sourceA.center),
              pointB: ensurePointEntity(sourceB),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isPointLikeShape(sourceA) && isCurveLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-point',
              pointA: ensurePointEntity(sourceA),
              pointB: ensurePointEntity(sourceB.center),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isCurveLikeShape(sourceA) && isCurveLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-point',
              pointA: ensurePointEntity(sourceA.center),
              pointB: ensurePointEntity(sourceB.center),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isSegmentLikeShape(sourceA) && isSegmentLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-line',
              point: ensureSegmentMidpointEntity(sourceA),
              line: ensureSegmentEntity(sourceB),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isSegmentLikeShape(sourceA) && isCurveLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-point',
              pointA: ensureSegmentMidpointEntity(sourceA),
              pointB: ensurePointEntity(sourceB.center),
              drivingState: 'driven',
              name,
            });
            return;
          }

          if (isCurveLikeShape(sourceA) && isSegmentLikeShape(sourceB)) {
            toolkit.addConstraint(sketch, {
              kind: 'distance-point-point',
              pointA: ensurePointEntity(sourceA.center),
              pointB: ensureSegmentMidpointEntity(sourceB),
              drivingState: 'driven',
              name,
            });
            return;
          }
          return;
        }
        case 'angle': {
          const helper = ensureSmartAngleHelperEntities(constraint);
          toolkit.addConstraint(sketch, {
            kind: 'angle',
            lineA: helper.lineA,
            lineB: helper.lineB,
            drivingState: 'driven',
            name,
          });
          return;
        }
        case 'radius': {
          toolkit.addConstraint(sketch, {
            kind: 'radius',
            entity: ensureCurveEntity(sourceA),
            drivingState: 'driven',
            name,
          });
          return;
        }
        case 'diameter': {
          toolkit.addConstraint(sketch, {
            kind: 'diameter',
            entity: ensureCurveEntity(sourceA),
            drivingState: 'driven',
            name,
          });
          return;
        }
        default:
          return;
      }
    }

    switch (constraint.dimType) {
      case 'distance': {
        const target = normalizeScalarSource(getDimensionScalarSource(constraint), parameters);

        if (isPointLikeShape(sourceA) && isPointLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(sourceA),
            pointB: ensurePointEntity(sourceB),
            value: target,
            name,
          });
          return;
        }

        if (isSegmentLikeShape(sourceA) && !sourceB) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(sourceA.p1),
            pointB: ensurePointEntity(sourceA.p2),
            value: target,
            name,
          });
          return;
        }

        if (isPointLikeShape(sourceA) && isSegmentLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-line',
            point: ensurePointEntity(sourceA),
            line: ensureSegmentEntity(sourceB),
            value: target,
            name,
          });
          return;
        }

        if (isSegmentLikeShape(sourceA) && isPointLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-line',
            point: ensurePointEntity(sourceB),
            line: ensureSegmentEntity(sourceA),
            value: target,
            name,
          });
          return;
        }

        if (isCurveLikeShape(sourceA) && isPointLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(sourceA.center),
            pointB: ensurePointEntity(sourceB),
            value: target,
            name,
          });
          return;
        }

        if (isPointLikeShape(sourceA) && isCurveLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(sourceA),
            pointB: ensurePointEntity(sourceB.center),
            value: target,
            name,
          });
          return;
        }

        if (isCurveLikeShape(sourceA) && isCurveLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(sourceA.center),
            pointB: ensurePointEntity(sourceB.center),
            value: target,
            name,
          });
          return;
        }

        if (isSegmentLikeShape(sourceA) && isSegmentLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-line',
            point: ensureSegmentMidpointEntity(sourceA),
            line: ensureSegmentEntity(sourceB),
            value: target,
            name,
          });
          return;
        }

        if (isSegmentLikeShape(sourceA) && isCurveLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensureSegmentMidpointEntity(sourceA),
            pointB: ensurePointEntity(sourceB.center),
            value: target,
            name,
          });
          return;
        }

        if (isCurveLikeShape(sourceA) && isSegmentLikeShape(sourceB)) {
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(sourceA.center),
            pointB: ensureSegmentMidpointEntity(sourceB),
            value: target,
            name,
          });
          return;
        }

        break;
      }
      case 'dx':
      case 'dy': {
        const target = normalizeScalarSource(getDimensionScalarSource(constraint), parameters);
        const horizontal = constraint.dimType === 'dx';

        if (isPointLikeShape(sourceA) && isPointLikeShape(sourceB)) {
          const pointAEntity = ensurePointEntity(sourceA);
          const pointBEntity = ensurePointEntity(sourceB);
          const helperSegment = addTransientSegmentEntity(pointAEntity, pointBEntity);

          toolkit.addConstraint(sketch, {
            kind: horizontal ? 'horizontal' : 'vertical',
            entity: helperSegment,
          });
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: pointAEntity,
            pointB: pointBEntity,
            value: target,
            name,
          });
          return;
        }

        if (isSegmentLikeShape(sourceA) && !sourceB) {
          toolkit.addConstraint(sketch, {
            kind: horizontal ? 'horizontal' : 'vertical',
            entity: ensureSegmentEntity(sourceA),
          });
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(sourceA.p1),
            pointB: ensurePointEntity(sourceA.p2),
            value: target,
            name,
          });
          return;
        }

        break;
      }
      case 'angle': {
        const helper = ensureSmartAngleHelperEntities(constraint);
        toolkit.addConstraint(sketch, {
          kind: 'angle',
          lineA: helper.lineA,
          lineB: helper.lineB,
          value: normalizeScalarSource(getDimensionScalarSource(constraint), parameters),
          name,
        });
        return;
      }
      case 'radius':
      case 'diameter': {
        toolkit.addConstraint(sketch, {
          kind: 'radius',
          entity: ensureCurveEntity(sourceA),
          value: normalizeScaledScalarSource(
            getDimensionScalarSource(constraint),
            parameters,
            constraint.dimType === 'diameter' ? 0.5 : 1,
          ),
          name,
        });
        return;
      }
      default:
        break;
    }

    throw new Error(`Sketch toolkit adapter does not support driving smart dimension kind: ${String(constraint?.dimType || 'unknown')}`);
  };

  try {
    for (const segment of scene.segments || []) {
      ensureSegmentEntity(segment);
    }

    if (typeof toolkit.setParameter === 'function') {
      for (const [name, value] of Object.entries(parameters)) {
        toolkit.setParameter(sketch, name, value);
      }
    }

    for (const constraint of scene.constraints || []) {
      switch (constraint?.type) {
        case 'fixed':
          toolkit.addConstraint(sketch, {
            kind: 'fix',
            entity: ensurePointEntity(constraint.pt),
          });
          break;
        case 'coincident':
          toolkit.addConstraint(sketch, {
            kind: 'coincident',
            pointA: ensurePointEntity(constraint.ptA),
            pointB: ensurePointEntity(constraint.ptB),
          });
          break;
        case 'distance':
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(constraint.ptA),
            pointB: ensurePointEntity(constraint.ptB),
            value: normalizeScalarSource(constraint.value, parameters),
          });
          break;
        case 'horizontal':
          toolkit.addConstraint(sketch, {
            kind: 'horizontal',
            entity: ensureSegmentEntity(constraint.seg),
          });
          break;
        case 'vertical':
          toolkit.addConstraint(sketch, {
            kind: 'vertical',
            entity: ensureSegmentEntity(constraint.seg),
          });
          break;
        case 'parallel':
          toolkit.addConstraint(sketch, {
            kind: 'parallel',
            entityA: ensureSegmentEntity(constraint.segA),
            entityB: ensureSegmentEntity(constraint.segB),
          });
          break;
        case 'perpendicular':
          toolkit.addConstraint(sketch, {
            kind: 'perpendicular',
            entityA: ensureSegmentEntity(constraint.segA),
            entityB: ensureSegmentEntity(constraint.segB),
          });
          break;
        case 'angle':
          toolkit.addConstraint(sketch, {
            kind: 'angle',
            lineA: ensureSegmentEntity(constraint.segA),
            lineB: ensureSegmentEntity(constraint.segB),
            value: normalizeScalarSource(constraint.value, parameters),
          });
          break;
        case 'equal_length':
          if (isCurveLikeShape(constraint.segA) && isCurveLikeShape(constraint.segB)) {
            toolkit.addConstraint(sketch, {
              kind: 'equal-radius',
              entityA: ensureCurveEntity(constraint.segA),
              entityB: ensureCurveEntity(constraint.segB),
            });
            break;
          }
          if (!isSegmentLikeShape(constraint.segA) || !isSegmentLikeShape(constraint.segB)) {
            throw new Error('Sketch toolkit adapter only supports equal_length between two segments or two curve-like shapes');
          }
          toolkit.addConstraint(sketch, {
            kind: 'equal-length',
            entityA: ensureSegmentEntity(constraint.segA),
            entityB: ensureSegmentEntity(constraint.segB),
          });
          break;
        case 'length':
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-point',
            pointA: ensurePointEntity(constraint.seg.p1),
            pointB: ensurePointEntity(constraint.seg.p2),
            value: normalizeScalarSource(constraint.value, parameters),
          });
          break;
        case 'on_line':
          toolkit.addConstraint(sketch, {
            kind: 'distance-point-line',
            point: ensurePointEntity(constraint.pt),
            line: ensureSegmentEntity(constraint.seg),
            value: 0,
          });
          break;
        case 'on_circle':
          if (!isCurveLikeShape(constraint.circle)) {
            throw new Error('Sketch toolkit adapter only supports on_circle against curve-like shapes');
          }
          toolkit.addConstraint(sketch, {
            kind: isArcLikeShape(constraint.circle) ? 'point-on-arc' : 'point-on-circle',
            point: ensurePointEntity(constraint.pt),
            entity: ensureCurveEntity(constraint.circle),
          });
          break;
        case 'radius':
          if (!isCurveLikeShape(constraint.shape)) {
            throw new Error('Sketch toolkit adapter only supports radius constraints on curve-like shapes');
          }
          toolkit.addConstraint(sketch, {
            kind: 'radius',
            entity: ensureCurveEntity(constraint.shape),
            value: normalizeScalarSource(constraint.value, parameters),
          });
          break;
        case 'tangent':
          if (isCurveLikeShape(constraint.seg) && isCurveLikeShape(constraint.circle)) {
            toolkit.addConstraint(sketch, {
              kind: 'tangent',
              entityA: ensureCurveEntity(constraint.seg),
              entityB: ensureCurveEntity(constraint.circle),
            });
            break;
          }
          if (isSegmentLikeShape(constraint.seg) && isCurveLikeShape(constraint.circle)) {
            toolkit.addConstraint(sketch, {
              kind: 'tangent',
              entityA: ensureSegmentEntity(constraint.seg),
              entityB: ensureCurveEntity(constraint.circle),
            });
            break;
          }
          throw new Error('Sketch toolkit adapter only supports tangent between a segment and a curve-like shape, or between two curve-like shapes');
        case 'dimension':
          addSmartDimensionConstraint(constraint);
          break;
        default:
          if (options.allowPartial !== true) {
            throw new Error(`Sketch toolkit adapter encountered an unsupported constraint type: ${String(constraint?.type || 'unknown')}`);
          }
          break;
      }
    }

    const result = toolkit.solveSketch(sketch, {
      ...DEFAULT_SOLVE_OPTIONS,
      ...(options.solveOptions || {}),
    });
    const snapshot = toolkit.getSketchSnapshot(sketch);

    for (const entity of snapshot.entities) {
      if (entity.kind === 'point') {
        const point = entityToPoint.get(entity.id);
        if (!point) continue;
        point.x = entity.x;
        point.y = entity.y;
        point.fixed = entity.fixed === true || fixedPointTargets.has(point);
        continue;
      }

      if (entity.kind === 'circle') {
        const shape = entityToCurve.get(entity.id);
        if (!shape) continue;
        shape.radius = entity.radius;
        continue;
      }

      if (entity.kind === 'arc') {
        const shape = entityToCurve.get(entity.id);
        if (!shape) continue;
        shape._radius = entity.radius;
        if (Number.isFinite(entity.startRadians)) {
          shape._startAngle = entity.startRadians;
        }
        if (Number.isFinite(entity.startRadians) && Number.isFinite(entity.sweepRadians)) {
          shape._endAngle = entity.startRadians + entity.sweepRadians;
        }
      }
    }

    for (const dimension of scene.dimensions || []) {
      if (dimension?.sourceA && typeof dimension.syncFromSources === 'function') {
        dimension.syncFromSources();
      }
    }

    applyDrivenDimensionMeasurements(scene.dimensions, result.drivenDimensions);

    return {
      result,
      snapshot,
      unsupportedConstraints,
      parameters,
    };
  } finally {
    toolkit.disposeSketch?.(sketch);
  }
}

export function solveSceneWithSharedSketchToolkit(scene, options = {}) {
  return solveSceneWithSketchToolkit(scene, getSharedSketchToolkitSync(), options);
}