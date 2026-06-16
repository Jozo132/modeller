import { buildCamPlaneFromFace, isWorldZAlignedPlane, normalizeCamPlane } from './plane.js';

export function createCamFaceSourceResolver(options = {}) {
  const logCamPick = (event, payload = {}) => {
    if (typeof options.logEvent !== 'function') return;
    try {
      options.logEvent(event, payload);
    } catch {}
  };

  const readReferenceGeometry = () => {
    if (typeof options.getReferenceGeometry !== 'function') return null;
    return options.getReferenceGeometry() || null;
  };

  const readReferenceTolerance = (geometry = readReferenceGeometry()) => {
    if (typeof options.getReferenceTolerance !== 'function') return 0.001;
    const tolerance = Number(options.getReferenceTolerance(geometry));
    return Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0.001;
  };

  const readRenderedFaces = () => {
    if (typeof options.getRenderedFaces !== 'function') return [];
    const faces = options.getRenderedFaces();
    return Array.isArray(faces) ? faces : [];
  };

  const buildExactFaceRef = (topoFaceOrRef, stableHash = null) => {
    const faceRef = {};
    if (Number.isFinite(Number(topoFaceOrRef?.id))) faceRef.topoId = Number(topoFaceOrRef.id);
    else if (Number.isFinite(Number(topoFaceOrRef?.topoId))) faceRef.topoId = Number(topoFaceOrRef.topoId);
    else if (Number.isFinite(Number(topoFaceOrRef))) faceRef.topoId = Number(topoFaceOrRef);
    if (typeof topoFaceOrRef?.stableHash === 'string' && topoFaceOrRef.stableHash) faceRef.stableHash = topoFaceOrRef.stableHash;
    else if (typeof stableHash === 'string' && stableHash) faceRef.stableHash = stableHash;
    return faceRef;
  };

  const readExactPlanarFaceWires = (topoFaceOrRef, geometry = readReferenceGeometry()) => {
    if (!topoFaceOrRef || typeof options.getExactPlanarFaceWires !== 'function') return null;
    const faceRef = buildExactFaceRef(topoFaceOrRef);
    if (!Number.isFinite(Number(faceRef.topoId)) && !faceRef.stableHash) return null;
    try {
      return options.getExactPlanarFaceWires({ geometry, topoFace: topoFaceOrRef?.surface ? topoFaceOrRef : null, faceRef }) || null;
    } catch {
      return null;
    }
  };

  function point3(value) {
    const x = Array.isArray(value) ? Number(value[0]) : Number(value?.x);
    const y = Array.isArray(value) ? Number(value[1]) : Number(value?.y);
    const z = Array.isArray(value) ? Number(value[2]) : Number(value?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
  }

  function subtract3(a, b) {
    return {
      x: a.x - b.x,
      y: a.y - b.y,
      z: a.z - b.z,
    };
  }

  function cross3(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  function normalize3(vector) {
    const point = point3(vector);
    if (!point) return null;
    const length = Math.hypot(point.x, point.y, point.z);
    if (length <= 1e-12) return null;
    return {
      x: point.x / length,
      y: point.y / length,
      z: point.z / length,
    };
  }

  function dot3(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  function negate3(vector) {
    return {
      x: -vector.x,
      y: -vector.y,
      z: -vector.z,
    };
  }

  function meshVerticesToCamLoop(vertices) {
    if (!Array.isArray(vertices) || vertices.length < 3) return null;
    const loop = [];
    for (const vertex of vertices) {
      const x = Number(vertex?.x);
      const y = Number(vertex?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const previous = loop[loop.length - 1];
      if (previous && Math.hypot(previous.x - x, previous.y - y) < 1e-8) continue;
      loop.push({ x, y });
    }
    if (loop.length > 1) {
      const first = loop[0];
      const last = loop[loop.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-8) loop.pop();
    }
    return loop.length >= 3 ? loop : null;
  }

  function faceHitToCamLoop(faceHit) {
    return meshVerticesToCamLoop(faceHit?.face?.vertices);
  }

  function selectedCamSourceFaceHits(faceHit, selectedFaces) {
    const selectedHits = selectedFaces instanceof Map ? Array.from(selectedFaces.values()) : [];
    const normalizedSelectedHits = selectedHits.filter((hit) => Number.isFinite(Number(hit?.faceIndex)));
    const useSelection = normalizedSelectedHits.length > 1
      && normalizedSelectedHits.some((hit) => Number(hit.faceIndex) === Number(faceHit?.faceIndex));
    const rawHits = useSelection ? normalizedSelectedHits : [faceHit];
    const seen = new Set();
    return rawHits.filter((hit) => {
      const faceIndex = Number(hit?.faceIndex);
      if (!Number.isFinite(faceIndex)) return false;
      if (seen.has(faceIndex)) return false;
      seen.add(faceIndex);
      return true;
    });
  }

  function readTopoFaces(geometry = readReferenceGeometry()) {
    return typeof geometry?.topoBody?.faces === 'function' ? geometry.topoBody.faces() : [];
  }

  function topoFacesUseZeroBasedIds(topoFaces) {
    if (!Array.isArray(topoFaces) || topoFaces.length === 0) return false;
    const ids = topoFaces.map((face) => Number(face?.id));
    if (ids.some((id) => !Number.isInteger(id))) return false;
    if (Math.min(...ids) !== 0 || Math.max(...ids) !== topoFaces.length - 1) return false;
    return new Set(ids).size === topoFaces.length;
  }

  function findTopoFaceById(topoFaceId, geometry = readReferenceGeometry()) {
    if (!Number.isInteger(topoFaceId)) return null;
    const topoFaces = readTopoFaces(geometry);
    const exactMatch = topoFaces.find((candidate) => candidate.id === topoFaceId) || null;
    if (exactMatch) return exactMatch;
    if (!topoFacesUseZeroBasedIds(topoFaces)) return null;
    return topoFaceId > 0 && topoFaceId <= topoFaces.length ? topoFaces[topoFaceId - 1] : null;
  }

  function faceHitsToCamSource(faceHits) {
    const seenSurfaceKeys = new Set();
    const surfaces = (Array.isArray(faceHits) ? faceHits : [])
      .map((faceHit) => faceHitToCamSourceSurface(faceHit))
      .filter((surface) => {
        if (!surface || !Array.isArray(surface.loops) || surface.loops.length === 0) return false;
        const surfaceKey = sourceSurfaceKey(surface);
        if (seenSurfaceKeys.has(surfaceKey)) return false;
        seenSurfaceKeys.add(surfaceKey);
        return true;
      });
    return combineCamSourceSurfaces(surfaces);
  }

  function sourceSurfaceKey(surface) {
    if (typeof surface?.referenceId === 'string' && surface.referenceId) return `reference:${surface.referenceId}`;
    if (Number.isFinite(Number(surface?.faceGroup))) return `group:${Number(surface.faceGroup)}`;
    if (Number.isFinite(Number(surface?.topoFaceId))) return `topoface:${Number(surface.topoFaceId)}`;
    if (Number.isFinite(Number(surface?.faceIndex))) return `face:${Number(surface.faceIndex)}`;
    return JSON.stringify(surface?.loops || []);
  }

  function combineCamSourceSurfaces(surfaces, baseSource = {}) {
    const normalizedSurfaces = (Array.isArray(surfaces) ? surfaces : [])
      .map((surface) => ({
        referenceId: surface.referenceId || null,
        label: surface.label || null,
        faceIndex: Number.isFinite(Number(surface.faceIndex)) ? Number(surface.faceIndex) : null,
        topoFaceId: Number.isFinite(Number(surface.topoFaceId)) ? Number(surface.topoFaceId) : null,
        faceGroup: Number.isFinite(Number(surface.faceGroup)) ? Number(surface.faceGroup) : null,
        edgeIndex: Number.isFinite(Number(surface.edgeIndex)) ? Number(surface.edgeIndex) : null,
        tolerance: Number.isFinite(Number(surface.tolerance)) && Number(surface.tolerance) > 0 ? Number(surface.tolerance) : null,
        plane: normalizeCamPlane(surface.plane),
        z: Number.isFinite(Number(surface.z)) ? Number(surface.z) : null,
        loops: Array.isArray(surface.loops) ? surface.loops : [],
        segmentLoops: Array.isArray(surface.segmentLoops) ? surface.segmentLoops : [],
      }))
      .filter((surface) => surface.loops.length > 0);
    if (normalizedSurfaces.length === 0) return null;

    const faceGroup = normalizedSurfaces.length === 1 ? normalizedSurfaces[0].faceGroup : null;
    const toleranceValues = normalizedSurfaces.map((surface) => surface.tolerance).filter((value) => Number.isFinite(value) && value > 0);
    const primary = normalizedSurfaces[0];
    return {
      type: 'face',
      referenceId: typeof baseSource.referenceId === 'string' && baseSource.referenceId
        ? baseSource.referenceId
        : (normalizedSurfaces.length === 1
          ? primary.referenceId
          : (faceGroup != null ? `facegroup-${faceGroup}` : 'face-selection')),
      label: typeof baseSource.label === 'string' && baseSource.label
        ? baseSource.label
        : (normalizedSurfaces.length === 1 ? primary.label : `${normalizedSurfaces.length} surfaces`),
      faceIndex: primary.faceIndex,
      topoFaceId: normalizedSurfaces.length === 1 ? primary.topoFaceId : null,
      faceGroup,
      edgeIndex: normalizedSurfaces.length === 1 ? primary.edgeIndex : null,
      tolerance: toleranceValues.length > 0 ? Math.min(...toleranceValues) : null,
      plane: normalizedSurfaces.length === 1 ? primary.plane : null,
      loops: normalizedSurfaces.flatMap((surface) => surface.loops),
      segmentLoops: normalizedSurfaces.flatMap((surface) => surface.segmentLoops || []),
      surfaces: normalizedSurfaces,
    };
  }

  function camFaceSourceSupportMessage(source) {
    const surfaces = Array.isArray(source?.surfaces) && source.surfaces.length > 0 ? source.surfaces : [source];
    for (const surface of surfaces) {
      const plane = normalizeCamPlane(surface?.plane);
      if (!plane) {
        return 'Selected surface is not a planar OCCT face. Current 2.5D CAM only supports planar face sources.';
      }
      if (!isWorldZAlignedPlane(plane)) {
        return 'Selected surface is not parallel to the XY machining plane. Current 2.5D CAM only supports horizontal planar face sources.';
      }
    }
    return null;
  }

  function faceGroupHitToCamSourceGeometry(faceHit, geometry = readReferenceGeometry()) {
    const faceGroup = Number.isFinite(Number(faceHit?.face?.faceGroup)) ? Number(faceHit.face.faceGroup) : null;
    return faceGroupKeyToCamSourceGeometry(faceGroup, geometry);
  }

  function faceGroupKeyToCamSourceGeometry(faceGroup, geometry = readReferenceGeometry()) {
    if (faceGroup == null) {
      logCamPick('face-group-skip', { reason: 'missing-face-group' });
      return { loops: [], segmentLoops: [], tolerance: readReferenceTolerance(geometry) };
    }

    const groupedFaces = readRenderedFaces()
      .filter((candidate) => Number.isFinite(Number(candidate?.faceGroup)) && Number(candidate.faceGroup) === faceGroup);
    if (groupedFaces.length === 0) {
      logCamPick('face-group-empty', { faceGroup });
      return { loops: [], segmentLoops: [], tolerance: readReferenceTolerance(geometry) };
    }

    const exactLoops = [];
    const exactSegmentLoops = [];
    const tolerances = [];
    const seenTopoFaceIds = new Set();
    for (const candidate of groupedFaces) {
      const topoFaceId = Number.isFinite(Number(candidate?.topoFaceId)) ? Number(candidate.topoFaceId) : null;
      if (topoFaceId == null || seenTopoFaceIds.has(topoFaceId)) continue;
      seenTopoFaceIds.add(topoFaceId);
      const topoFace = findTopoFaceById(topoFaceId, geometry);
      if (!topoFace) {
        const exactWires = readExactPlanarFaceWires({ topoId: topoFaceId }, geometry);
        if (exactWires) {
          const sourceGeometry = exactPlanarFaceWiresToCamSourceGeometry(exactWires, readReferenceTolerance(geometry));
          if (sourceGeometry.loops.length > 0) {
            exactLoops.push(...sourceGeometry.loops);
            if (sourceGeometry.segmentLoops.length > 0) exactSegmentLoops.push(...sourceGeometry.segmentLoops);
            tolerances.push(readReferenceTolerance(geometry));
            logCamPick('face-group-exact-ref-resolved', {
              faceGroup,
              topoFaceId,
              loopCount: sourceGeometry.loops.length,
            });
            continue;
          }
        }
        logCamPick('face-group-topo-miss', {
          faceGroup,
          topoFaceId,
          availableTopoFaceIds: readTopoFaces(geometry).map((face) => face.id),
          hasOcctHandle: Number(geometry?.occtShapeHandle) > 0,
        });
        continue;
      }
      const sourceGeometry = resolvedTopoFaceToCamSourceGeometry(topoFace, geometry);
      if (sourceGeometry.loops.length === 0) {
        logCamPick('face-group-no-loops', { faceGroup, topoFaceId, topoFaceResolvedId: topoFace.id });
        continue;
      }
      exactLoops.push(...sourceGeometry.loops);
      if (sourceGeometry.segmentLoops.length > 0) exactSegmentLoops.push(...sourceGeometry.segmentLoops);
      if (Number.isFinite(sourceGeometry.tolerance) && sourceGeometry.tolerance > 0) tolerances.push(sourceGeometry.tolerance);
    }
    if (exactLoops.length > 0) {
      logCamPick('face-group-resolved', {
        faceGroup,
        loopCount: exactLoops.length,
        segmentLoopCount: exactSegmentLoops.length,
      });
      return {
        loops: exactLoops,
        segmentLoops: exactSegmentLoops,
        tolerance: tolerances.length > 0 ? Math.min(...tolerances) : readReferenceTolerance(geometry),
      };
    }

    logCamPick('face-group-no-boundary', { faceGroup, renderedFaceCount: groupedFaces.length });
    return { loops: [], segmentLoops: [], tolerance: readReferenceTolerance(geometry) };
  }

  function faceHitToCamSourceSurface(faceHit) {
    const geometry = readReferenceGeometry();
    const topoFaceId = Number.isFinite(Number(faceHit?.face?.topoFaceId)) ? Number(faceHit.face.topoFaceId) : null;
    const topoFace = topoFaceId != null ? findTopoFaceById(topoFaceId, geometry) : null;
    const directExactWires = topoFaceId != null && !topoFace ? readExactPlanarFaceWires({ topoId: topoFaceId }, geometry) : null;
    const directExactSourceGeometry = directExactWires
      ? {
        ...exactPlanarFaceWiresToCamSourceGeometry(directExactWires, readReferenceTolerance(geometry)),
        tolerance: readReferenceTolerance(geometry),
        plane: camPlaneFromExactPlanarFaceWires(directExactWires),
      }
      : null;
    if (topoFaceId != null && !topoFace) {
      logCamPick('face-hit-topo-miss', {
        faceIndex: faceHit?.faceIndex ?? null,
        faceGroup: Number.isFinite(Number(faceHit?.face?.faceGroup)) ? Number(faceHit.face.faceGroup) : null,
        topoFaceId,
        availableTopoFaceIds: readTopoFaces(geometry).map((face) => face.id),
        hasOcctHandle: Number(geometry?.occtShapeHandle) > 0,
        exactWireLoopCount: directExactSourceGeometry?.loops?.length ?? 0,
      });
    }
    const resolvedSourceGeometry = topoFace ? resolvedTopoFaceToCamSourceGeometry(topoFace, geometry) : directExactSourceGeometry;
    const plane = resolvedSourceGeometry?.plane || camPlaneFromFaceHit(faceHit, topoFace);
    const faceGroup = Number.isFinite(Number(faceHit?.face?.faceGroup)) ? Number(faceHit.face.faceGroup) : null;
    const groupSourceGeometry = faceGroupHitToCamSourceGeometry(faceHit, geometry);
    if (groupSourceGeometry.loops.length > 0) {
      logCamPick('face-hit-group-resolved', {
        faceIndex: faceHit?.faceIndex ?? null,
        faceGroup,
        topoFaceId,
        loopCount: groupSourceGeometry.loops.length,
      });
      return {
        referenceId: faceGroup != null ? `facegroup-${faceGroup}` : `face-${faceHit.faceIndex}`,
        label: faceGroup != null ? `Surface ${faceGroup}` : `Face ${faceHit.faceIndex}`,
        faceIndex: faceHit.faceIndex,
        topoFaceId,
        faceGroup,
        tolerance: groupSourceGeometry.tolerance,
        plane,
        z: faceHitZ(faceHit),
        loops: groupSourceGeometry.loops,
        segmentLoops: groupSourceGeometry.segmentLoops,
      };
    }

    if (topoFaceId != null && resolvedSourceGeometry) {
      const sourceGeometry = resolvedSourceGeometry || resolvedTopoFaceToCamSourceGeometry(topoFace, geometry);
      if (sourceGeometry.loops.length > 0) {
        logCamPick('face-hit-topo-resolved', {
          faceIndex: faceHit?.faceIndex ?? null,
          faceGroup,
          topoFaceId,
          topoFaceResolvedId: topoFace?.id ?? null,
          loopCount: sourceGeometry.loops.length,
          segmentLoopCount: sourceGeometry.segmentLoops.length,
        });
        return {
          referenceId: `topoface-${topoFaceId}`,
          label: `Face ${topoFaceId}`,
          faceIndex: faceHit.faceIndex,
          topoFaceId,
          faceGroup,
          tolerance: sourceGeometry.tolerance,
          plane,
          z: faceHitZ(faceHit),
          loops: sourceGeometry.loops,
          segmentLoops: sourceGeometry.segmentLoops,
        };
      }
      logCamPick('face-hit-topo-no-loops', {
        faceIndex: faceHit?.faceIndex ?? null,
        faceGroup,
        topoFaceId,
        topoFaceResolvedId: topoFace?.id ?? null,
        usedDirectExactRef: !!directExactSourceGeometry,
      });
    }

    logCamPick('face-hit-no-source', {
      faceIndex: faceHit?.faceIndex ?? null,
      faceGroup,
      topoFaceId,
      hasTopoFace: !!topoFace,
      renderedVertexCount: Array.isArray(faceHit?.face?.vertices) ? faceHit.face.vertices.length : 0,
    });
    return null;
  }

  function camPlaneFromFaceHit(faceHit, topoFace = null) {
    if (!topoFace || (topoFace.surfaceType && topoFace.surfaceType !== 'plane')) return null;
    return camPlaneFromTopoFace(topoFace);
  }

  function camPlaneFromTopoFace(topoFace) {
    const surface = topoFace?.surface;
    if (surface && Array.isArray(surface.controlPoints) && surface.controlPoints.length >= 4) {
      const origin = point3(surface.controlPoints[0]);
      const xAxis = normalize3(subtract3(surface.controlPoints[2], surface.controlPoints[0]));
      let yAxis = normalize3(subtract3(surface.controlPoints[1], surface.controlPoints[0]));
      let normal = xAxis && yAxis ? normalize3(cross3(xAxis, yAxis)) : null;
      if (origin && xAxis && yAxis && normal) {
        if (topoFace.sameSense === false) {
          yAxis = negate3(yAxis);
          normal = negate3(normal);
        }
        return { origin, normal, xAxis, yAxis };
      }
    }

    const exactPoints = topoFaceExactPoints(topoFace);
    if (exactPoints.length === 0) return null;
    const normalHint = topoFaceSurfaceNormal(topoFace);
    return buildCamPlaneFromFace(exactPoints, normalHint);
  }

  function topoFaceExactPoints(topoFace) {
    const points = [];
    for (const loop of topoFace?.allLoops?.() || []) {
      for (const vertex of loop?.vertices?.() || []) {
        const point = point3(vertex?.point);
        if (point) points.push(point);
      }
    }
    return points;
  }

  function topoFaceSurfaceNormal(topoFace) {
    const surface = topoFace?.surface;
    if (!surface || typeof surface.normal !== 'function') return null;
    const u = Number.isFinite(surface.uMin) ? surface.uMin : 0;
    const v = Number.isFinite(surface.vMin) ? surface.vMin : 0;
    const normal = normalize3(surface.normal(u, v));
    if (!normal) return null;
    return topoFace.sameSense === false ? negate3(normal) : normal;
  }

  function faceHitToCamSource(faceHit) {
    return faceHitsToCamSource([faceHit]);
  }

  function hydrateCamFaceSource(source) {
    const sourceSurfaces = Array.isArray(source?.surfaces) && source.surfaces.length > 0 ? source.surfaces : [source];
    const hydratedSurfaces = sourceSurfaces
      .map((surface) => hydrateCamFaceSourceSurface(surface))
      .filter((surface) => surface && Array.isArray(surface.loops) && surface.loops.length > 0);
    if (hydratedSurfaces.length === 0) return source;
    return combineCamSourceSurfaces(hydratedSurfaces, source) || source;
  }

  function hydrateCamFaceSourceSurface(surface) {
    const geometry = readReferenceGeometry();
    const faceGroup = Number.isFinite(Number(surface?.faceGroup))
      ? Number(surface.faceGroup)
      : camSourceFaceGroupFromReferenceId(surface?.referenceId);
    if (faceGroup != null) {
      const groupSourceGeometry = faceGroupKeyToCamSourceGeometry(faceGroup, geometry);
      if (groupSourceGeometry.loops.length > 0) {
        return {
          ...surface,
          referenceId: `facegroup-${faceGroup}`,
          label: surface?.label || `Surface ${faceGroup}`,
          faceGroup,
          loops: groupSourceGeometry.loops,
          segmentLoops: groupSourceGeometry.segmentLoops,
          tolerance: groupSourceGeometry.tolerance,
        };
      }
    }

    const topoFaceId = Number.isFinite(Number(surface?.topoFaceId))
      ? Number(surface.topoFaceId)
      : camSourceTopoFaceIdFromReferenceId(surface?.referenceId);
    if (topoFaceId != null) {
      const topoFace = findTopoFaceById(topoFaceId, geometry);
      const sourceGeometry = resolvedTopoFaceToCamSourceGeometry(topoFace, geometry);
      if (sourceGeometry.loops.length > 0) {
        return {
          ...surface,
          referenceId: `topoface-${topoFaceId}`,
          label: surface?.label || `Face ${topoFaceId}`,
          topoFaceId,
          loops: sourceGeometry.loops,
          segmentLoops: sourceGeometry.segmentLoops,
          tolerance: sourceGeometry.tolerance,
          plane: sourceGeometry.plane || surface?.plane || null,
        };
      }
    }

    return surface;
  }

  function camSourceFaceGroupFromReferenceId(referenceId) {
    const match = typeof referenceId === 'string' ? /^facegroup-(-?\d+)$/.exec(referenceId.trim()) : null;
    return match ? Number(match[1]) : null;
  }

  function camSourceTopoFaceIdFromReferenceId(referenceId) {
    const match = typeof referenceId === 'string' ? /^topoface-(-?\d+)$/.exec(referenceId.trim()) : null;
    return match ? Number(match[1]) : null;
  }

  function getCamToleranceForTopoFace(topoFace, geometry = readReferenceGeometry()) {
    const values = [];
    if (Number.isFinite(topoFace?.tolerance) && topoFace.tolerance > 0) values.push(topoFace.tolerance);
    for (const loop of topoFace?.allLoops?.() || []) {
      for (const coedge of loop?.coedges || []) {
        if (Number.isFinite(coedge?.edge?.tolerance) && coedge.edge.tolerance > 0) values.push(coedge.edge.tolerance);
      }
    }
    if (values.length === 0) return readReferenceTolerance(geometry);
    return Math.max(1e-6, Math.min(...values));
  }

  function resolvedTopoFaceToCamSourceGeometry(topoFace, geometry = readReferenceGeometry()) {
    const tolerance = getCamToleranceForTopoFace(topoFace, geometry);
    const exactWires = readExactPlanarFaceWires(topoFace, geometry);
    if (exactWires) {
      const sourceGeometry = exactPlanarFaceWiresToCamSourceGeometry(exactWires, tolerance);
      if (sourceGeometry.loops.length > 0) {
        return {
          ...sourceGeometry,
          tolerance,
          plane: camPlaneFromExactPlanarFaceWires(exactWires),
        };
      }
    }
    const plane = camPlaneFromTopoFace(topoFace);
    return {
      ...topoFaceToCamSourceGeometry(topoFace, tolerance, plane),
      tolerance,
      plane,
    };
  }

  function projectPointToCamPlane(point, plane) {
    const p = point3(point);
    const origin = point3(plane?.origin);
    const xAxis = normalize3(plane?.xAxis);
    const yAxis = normalize3(plane?.yAxis);
    if (!p || !origin || !xAxis || !yAxis) return camPoint2(point);
    const offset = subtract3(p, origin);
    return {
      x: dot3(offset, xAxis),
      y: dot3(offset, yAxis),
    };
  }

  function camPlaneFromExactPlanarFaceWires(result) {
    const origin = point3(result?.plane?.origin);
    const normal = normalize3(result?.plane?.normal);
    const xAxis = normalize3(result?.plane?.xDirection);
    const yAxis = normal && xAxis ? normalize3(cross3(normal, xAxis)) : null;
    if (!origin || !normal || !xAxis || !yAxis) return null;
    return { origin, normal, xAxis, yAxis };
  }

  function exactPlanarFaceWiresToCamSourceGeometry(result, tolerance) {
    const loops = [];
    const segmentLoops = [];
    const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0.001;
    for (const wire of Array.isArray(result?.wires) ? result.wires : []) {
      const points = [];
      const segments = [];
      let hasExactLoop = true;
      for (const wireSegment of Array.isArray(wire?.segments) ? wire.segments : []) {
        for (const point of planarCurveToCamLoopPoints(wireSegment?.planarCurve)) {
          const previous = points[points.length - 1];
          if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) <= Math.max(tol, 1e-8)) continue;
          points.push(point);
        }
        if (hasExactLoop) {
          const exactSegment = planarCurveToCamSegment(wireSegment?.planarCurve, tol);
          if (!exactSegment) {
            hasExactLoop = false;
          } else {
            segments.push(exactSegment);
          }
        }
      }
      if (points.length > 1) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(tol, 1e-8)) points.pop();
      }
      if (points.length >= 3) {
        loops.push(points);
        if (hasExactLoop && segments.length > 0) segmentLoops.push(segments);
      }
    }
    return { loops, segmentLoops };
  }

  function planarCurveToCamLoopPoints(curve) {
    const points = [camPoint2(curve?.startPoint)];
    if (curve?.curveType !== 'line') points.push(camPoint2(curve?.midPoint));
    points.push(camPoint2(curve?.endPoint));
    return points.filter(Boolean).filter((point, index, all) => {
      if (index === 0) return true;
      const previous = all[index - 1];
      return !previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 1e-8;
    });
  }

  function planarCurveToCamSegment(curve, tolerance) {
    if (!curve || typeof curve !== 'object') return null;
    if (curve.curveType === 'line') return lineSegmentFromCamPoints(curve.startPoint, curve.endPoint);
    if (curve.curveType === 'circle') return circleCurveToCamArcSegment(curve);
    if (curve.curveType === 'bezier') return bezierCurveToCamSegment(curve, tolerance);
    if (curve.curveType === 'bspline') return bsplineCurveToCamSegment(curve, tolerance);
    return null;
  }

  function circleCurveToCamArcSegment(curve) {
    const start = camPoint2(curve?.startPoint);
    const mid = camPoint2(curve?.midPoint);
    const end = camPoint2(curve?.endPoint);
    const center = camPoint2(curve?.circle?.center);
    if (!start || !mid || !end || !center) return null;
    return {
      type: 'arc',
      start,
      end,
      center,
      clockwise: arcPointsAreClockwise(start, mid, center),
    };
  }

  function bezierCurveToCamSegment(curve, tolerance) {
    const bezier = curve?.bezier;
    const poles = Array.isArray(bezier?.poles) ? bezier.poles.map((pole) => camPoint2(pole)).filter(Boolean) : [];
    if (bezier?.degree === 1 && poles.length >= 2) return lineSegmentFromCamPoints(poles[0], poles[poles.length - 1]);
    if (bezier?.degree !== 3 || poles.length !== 4 || !curveWeightsAreUnit(bezier?.weights)) return null;
    if (!camPointsSharePlane(poles, tolerance)) return null;
    return {
      type: 'cubic',
      start: poles[0],
      control1: poles[1],
      control2: poles[2],
      end: poles[3],
    };
  }

  function bsplineCurveToCamSegment(curve, tolerance) {
    const bspline = curve?.bspline;
    const poles = Array.isArray(bspline?.poles) ? bspline.poles.map((pole) => camPoint2(pole)).filter(Boolean) : [];
    if (bspline?.degree === 1 && poles.length >= 2) return lineSegmentFromCamPoints(poles[0], poles[poles.length - 1]);
    if (bspline?.degree !== 3 || poles.length !== 4 || bspline?.periodic || !curveWeightsAreUnit(bspline?.weights)) return null;
    if (!camPointsSharePlane(poles, tolerance)) return null;
    return {
      type: 'cubic',
      start: poles[0],
      control1: poles[1],
      control2: poles[2],
      end: poles[3],
    };
  }

  function curveWeightsAreUnit(weights) {
    const values = Array.isArray(weights) ? weights : [];
    if (values.length === 0) return true;
    return values.every((weight) => Math.abs((Number(weight) || 1) - 1) <= 1e-8);
  }

  function arcPointsAreClockwise(start, mid, center) {
    const ax = start.x - center.x;
    const ay = start.y - center.y;
    const bx = mid.x - center.x;
    const by = mid.y - center.y;
    return ax * by - ay * bx < 0;
  }

  function topoFaceToCamSourceGeometry(topoFace, tolerance, plane = null) {
    if (!topoFace || typeof topoFace.allLoops !== 'function') return { loops: [], segmentLoops: [] };
    const loops = [];
    const segmentLoops = [];
    const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0.001;
    for (const loop of topoFace.allLoops()) {
      const points = [];
      const segments = [];
      let hasExactLoop = true;
      for (const coedge of loop?.coedges || []) {
        const coedgeGeometry = sampleCamCoedgeGeometry(coedge, tol);
        for (let index = 0; index < coedgeGeometry.points.length; index++) {
          const point = plane ? projectPointToCamPlane(coedgeGeometry.points[index], plane) : camPoint2(coedgeGeometry.points[index]);
          if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
          const previous = points[points.length - 1];
          if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) <= Math.max(tol, 1e-8)) continue;
          points.push({ x: point.x, y: point.y });
        }
        if (hasExactLoop) {
          if (!Array.isArray(coedgeGeometry.exactSegments) || coedgeGeometry.exactSegments.length === 0 || (plane && !isWorldZAlignedPlane(plane))) {
            hasExactLoop = false;
          } else {
            segments.push(...coedgeGeometry.exactSegments);
          }
        }
      }
      if (points.length > 1) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(tol, 1e-8)) points.pop();
      }
      if (points.length >= 3) {
        loops.push(points);
        if (hasExactLoop && segments.length > 0) segmentLoops.push(segments);
      }
    }
    return { loops, segmentLoops };
  }

  function sampleCamCoedgeGeometry(coedge, tolerance) {
    const MIN_CURVE_DOMAIN_RANGE = 1e-12;
    const start = coedge?.startVertex?.()?.point;
    const end = coedge?.endVertex?.()?.point;
    const edgeCurve = coedge?.edge?.curve;
    if (!edgeCurve || typeof edgeCurve.evaluate !== 'function') {
      const lineSegment = lineSegmentFromCamPoints(start, end);
      return {
        points: [start, end].filter(Boolean),
        exactSegments: lineSegment ? [lineSegment] : [],
      };
    }
    let curve = edgeCurve;
    if (coedge?.sameSense === false && typeof edgeCurve.reversed === 'function') {
      curve = edgeCurve.reversed();
    }
    const domainStart = Number.isFinite(curve.uMin) ? curve.uMin : curve.knots?.[0];
    const domainEnd = Number.isFinite(curve.uMax) ? curve.uMax : curve.knots?.[curve.knots.length - 1];
    if (!Number.isFinite(domainStart) || !Number.isFinite(domainEnd) || Math.abs(domainEnd - domainStart) <= MIN_CURVE_DOMAIN_RANGE) {
      const lineSegment = lineSegmentFromCamPoints(start, end);
      return {
        points: [start, end].filter(Boolean),
        exactSegments: lineSegment ? [lineSegment] : [],
      };
    }
    return {
      points: sampleCamCurve(curve, domainStart, domainEnd, tolerance),
      exactSegments: curveToCamSegments(curve, tolerance),
    };
  }

  function sampleCamCurve(curve, tStart, tEnd, tolerance) {
    const MIN_SEGMENT_LENGTH_SQUARED = 1e-24;
    const pStart = curve.evaluate(tStart);
    const pEnd = curve.evaluate(tEnd);
    const points = [pStart];
    const maxDepth = 12;
    const tol = Math.max(1e-6, Number(tolerance) || 0.001);
    const distancePointToSegment = (point, a, b) => {
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abz = b.z - a.z;
      const apx = point.x - a.x;
      const apy = point.y - a.y;
      const apz = point.z - a.z;
      const denom = abx * abx + aby * aby + abz * abz;
      if (denom <= MIN_SEGMENT_LENGTH_SQUARED) return Math.hypot(apx, apy, apz);
      const ratio = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / denom));
      const px = a.x + abx * ratio;
      const py = a.y + aby * ratio;
      const pz = a.z + abz * ratio;
      return Math.hypot(point.x - px, point.y - py, point.z - pz);
    };
    const append = (aT, aP, bT, bP, depth) => {
      const midT = (aT + bT) * 0.5;
      const midP = curve.evaluate(midT);
      if (depth < maxDepth && distancePointToSegment(midP, aP, bP) > tol) {
        append(aT, aP, midT, midP, depth + 1);
        append(midT, midP, bT, bP, depth + 1);
        return;
      }
      points.push(bP);
    };
    append(tStart, pStart, tEnd, pEnd, 0);
    return points;
  }

  function curveToCamSegments(curve, tolerance) {
    const spans = splitCamCurveIntoBezierSpans(curve);
    if (!Array.isArray(spans) || spans.length === 0) return null;
    const segments = [];
    for (const span of spans) {
      const segment = curveSpanToCamSegment(span, tolerance);
      if (!segment) return null;
      segments.push(segment);
    }
    return segments;
  }

  function splitCamCurveIntoBezierSpans(curve) {
    if (!curve || typeof curve !== 'object') return null;
    const spans = [curve];
    const knots = Array.isArray(curve.knots) ? curve.knots : [];
    const domainStart = Number.isFinite(curve.uMin) ? curve.uMin : knots[0];
    const domainEnd = Number.isFinite(curve.uMax) ? curve.uMax : knots[knots.length - 1];
    if (!Number.isFinite(domainStart) || !Number.isFinite(domainEnd)) return null;
    const splitParameters = [];
    for (const knot of knots) {
      const value = Number(knot);
      if (!Number.isFinite(value) || value <= domainStart + 1e-10 || value >= domainEnd - 1e-10) continue;
      if (splitParameters.every((candidate) => Math.abs(candidate - value) > 1e-10)) splitParameters.push(value);
    }
    splitParameters.sort((left, right) => left - right);
    for (const parameter of splitParameters) {
      for (let index = 0; index < spans.length; index++) {
        const span = spans[index];
        const spanStart = Number.isFinite(span.uMin) ? span.uMin : span.knots?.[0];
        const spanEnd = Number.isFinite(span.uMax) ? span.uMax : span.knots?.[span.knots.length - 1];
        if (!(parameter > spanStart + 1e-10 && parameter < spanEnd - 1e-10)) continue;
        const split = typeof span.splitAt === 'function' ? span.splitAt(parameter) : null;
        if (!Array.isArray(split) || split.length !== 2) return null;
        spans.splice(index, 1, split[0], split[1]);
        break;
      }
    }
    return spans;
  }

  function curveSpanToCamSegment(curve, tolerance) {
    if (isStraightCamCurve(curve)) {
      const start = camPoint2(curve?.evaluate?.(curve.uMin) || curve?.controlPoints?.[0]);
      const end = camPoint2(curve?.evaluate?.(curve.uMax) || curve?.controlPoints?.[curve.controlPoints.length - 1]);
      return lineSegmentFromCamPoints(start, end);
    }

    const cubicSegment = curveSpanToCamCubicSegment(curve, tolerance);
    if (cubicSegment) return cubicSegment;

    const arcSegment = curveSpanToCamArcSegment(curve, tolerance);
    if (arcSegment) return arcSegment;

    return null;
  }

  function curveSpanToCamArcSegment(curve, tolerance) {
    if (!curve || curve.degree !== 2 || !Array.isArray(curve.controlPoints) || curve.controlPoints.length !== 3) return null;
    if (!looksLikeCircularArcSpan(curve)) return null;
    const start3 = curve.evaluate(curve.uMin);
    const end3 = curve.evaluate(curve.uMax);
    const mid3 = curve.evaluate((curve.uMin + curve.uMax) * 0.5);
    const start = camPoint2(start3);
    const end = camPoint2(end3);
    const mid = camPoint2(mid3);
    if (!start || !end || !mid) return null;
    const center = camCircumcenter(start, mid, end);
    if (!center) return null;
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    const checkTolerance = Math.max(1e-5, Number(tolerance) || 0.001, radius * 1e-5);
    for (const sampleT of [0.25, 0.5, 0.75]) {
      const samplePoint = camPoint2(curve.evaluate(curve.uMin + (curve.uMax - curve.uMin) * sampleT));
      if (!samplePoint) return null;
      const sampleRadius = Math.hypot(samplePoint.x - center.x, samplePoint.y - center.y);
      if (Math.abs(sampleRadius - radius) > checkTolerance) return null;
    }
    const sweep = (start.x - center.x) * (end.y - center.y) - (start.y - center.y) * (end.x - center.x);
    if (Math.abs(sweep) <= 1e-9) return null;
    return {
      type: 'arc',
      start,
      end,
      center,
      clockwise: sweep < 0,
    };
  }

  function curveSpanToCamCubicSegment(curve, tolerance) {
    if (!curve || curve.degree !== 3 || !Array.isArray(curve.controlPoints) || curve.controlPoints.length !== 4) return null;
    if (!curveHasUnitWeights(curve)) return null;
    if (!camPointsSharePlane(curve.controlPoints, tolerance)) return null;
    const start = camPoint2(curve.controlPoints[0]);
    const control1 = camPoint2(curve.controlPoints[1]);
    const control2 = camPoint2(curve.controlPoints[2]);
    const end = camPoint2(curve.controlPoints[3]);
    if (!start || !control1 || !control2 || !end) return null;
    return {
      type: 'cubic',
      start,
      control1,
      control2,
      end,
    };
  }

  function lineSegmentFromCamPoints(start, end) {
    const a = camPoint2(start);
    const b = camPoint2(end);
    if (!a || !b) return null;
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9) return null;
    return { type: 'line', start: a, end: b };
  }

  function camPoint2(point) {
    const x = Array.isArray(point) ? Number(point[0]) : Number(point?.x);
    const y = Array.isArray(point) ? Number(point[1]) : Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function camPointsSharePlane(points, tolerance) {
    const values = (Array.isArray(points) ? points : []).map((point) => Number(point?.z)).filter((value) => Number.isFinite(value));
    if (values.length <= 1) return true;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return Math.abs(max - min) <= Math.max(1e-6, Number(tolerance) || 0.001);
  }

  function curveHasUnitWeights(curve) {
    const weights = Array.isArray(curve?.weights) ? curve.weights : [];
    if (weights.length === 0) return true;
    return weights.every((weight) => Math.abs((Number(weight) || 1) - 1) <= 1e-8);
  }

  function looksLikeCircularArcSpan(curve) {
    const weights = Array.isArray(curve?.weights) ? curve.weights.map((weight) => Number(weight)) : [];
    if (weights.length !== 3 || weights.some((weight) => !Number.isFinite(weight) || Math.abs(weight) <= 1e-12)) return false;
    const normalizedMid = weights[1] / weights[0];
    const normalizedEnd = weights[2] / weights[0];
    return Math.abs(normalizedEnd - 1) <= 1e-6 && Math.abs(normalizedMid - 1) > 1e-6;
  }

  function isStraightCamCurve(curve) {
    if (!curve) return true;
    if (curve.degree === 1 && curve.controlPoints && curve.controlPoints.length === 2) return true;
    const points = Array.isArray(curve.controlPoints) ? curve.controlPoints : [];
    if (points.length < 2) return true;
    const start = points[0];
    const end = points[points.length - 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = (Number(end.z) || 0) - (Number(start.z) || 0);
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-12) return true;
    for (let index = 1; index < points.length - 1; index++) {
      const point = points[index];
      const px = point.x - start.x;
      const py = point.y - start.y;
      const pz = (Number(point.z) || 0) - (Number(start.z) || 0);
      const cx = dy * pz - dz * py;
      const cy = dz * px - dx * pz;
      const cz = dx * py - dy * px;
      if (Math.hypot(cx, cy, cz) / length > 1e-6) return false;
    }
    return true;
  }

  function camCircumcenter(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) <= 1e-12) return null;
    const aSq = a.x * a.x + a.y * a.y;
    const bSq = b.x * b.x + b.y * b.y;
    const cSq = c.x * c.x + c.y * c.y;
    return {
      x: (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d,
      y: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
    };
  }

  function faceHitZ(faceHit) {
    const vertices = faceHit?.face?.vertices;
    if (Array.isArray(vertices) && vertices.length > 0) {
      const zValues = vertices.map((vertex) => Number(vertex.z)).filter(Number.isFinite);
      if (zValues.length > 0) return zValues.reduce((sum, z) => sum + z, 0) / zValues.length;
    }
    return Number(faceHit?.point?.z) || 0;
  }

  return {
    camFaceSourceSupportMessage,
    combineCamSourceSurfaces,
    faceHitToCamSource,
    faceHitsToCamSource,
    faceHitZ,
    hydrateCamFaceSource,
    selectedCamSourceFaceHits,
  };
}