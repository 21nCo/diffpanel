export {
  createVariantsRegistry,
  getVariantsRegistry,
  installPageApi,
  MAX_SLOTS,
  validateSlotDefinition,
  VariantsRegistry,
  type SlotDefinition,
  type VariantsRegistryOptions,
} from "./registry.js";
export {
  browserEnvironment,
  readVariantParam,
  withVariantParam,
  type VariantsEnvironment,
  type VariantStorage,
} from "./environment.js";
export {
  markSlotRange,
  markSlotRoot,
  SLOT_BOUNDARY_ATTRIBUTE,
  slotBoundaryAttributes,
  slotRootAttributes,
} from "./slot-root.js";
export {
  PAGE_API_GLOBAL,
  SLOT_ATTRIBUTE,
  VARIANT_STORAGE_KEY,
  VARIANT_URL_PARAM,
  type IterbarPageApi,
  type RegistrySnapshot,
  type RegistryWarning,
  type SlotState,
  type VariantSelection,
} from "iterbar";
