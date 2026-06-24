import { CATALOG_ENTRIES, buildCatalogEntryMap } from "./tool-catalog.js";

const catalogToolMap = buildCatalogEntryMap(CATALOG_ENTRIES);

async function server(_input: unknown, _options?: Record<string, unknown>) {
  return {
    tool: catalogToolMap,
  };
}

export default { id: "opencode-native-tool-bridge", server };