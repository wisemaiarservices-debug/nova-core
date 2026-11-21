import { createIngestionHandler } from "./ingestion-handler.mjs";

export default {
  fetch: createIngestionHandler(),
};
