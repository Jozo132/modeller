// js/ir/index.js — Public re-exports for the CBREP binary IR layer
//
// This barrel module exposes the packages/ir/* API under the js/ tree so
// consumers can import from 'modeller/ir' without knowing the internal
// packages/ layout.

export {
  CBREP_MAGIC,
  CBREP_VERSION,
  FeatureFlag,
  SectionType,
  SurfTypeId,
  SurfTypeStr,
  HEADER_SIZE,
  SECTION_ENTRY_SIZE,
  NULL_IDX,
  SurfInfoTypeId,
  SurfInfoTypeStr,
  CbrepError,
} from '../../packages/ir/schema.js';

export { snapFloat, snapPoint, canonicalize } from '../../packages/ir/canonicalize.js';
export { writeCbrep } from '../../packages/ir/writer.js';
export { validateCbrep, readCbrepCanon, readCbrep, setTopoDeps } from '../../packages/ir/reader.js';
export { hashCbrep } from '../../packages/ir/hash.js';
