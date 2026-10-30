import { ROUTE_DEFINITIONS as coreRoutes } from "./routes.js";
import { WEB_AI_ROUTE_DEFINITIONS } from "./web-ai.js";
import { LLM_PREFERENCE_ROUTE_DEFINITIONS } from "./llm-preferences.js";
import { LEGACY_ATTACHMENT_ROUTE_DEFINITIONS } from "./legacy-attachments.js";
import { PASSPORT_ROUTE_DEFINITIONS } from "./passport.js";
export const ROUTE_DEFINITIONS = [
  ...coreRoutes,
  ...WEB_AI_ROUTE_DEFINITIONS,
  ...LLM_PREFERENCE_ROUTE_DEFINITIONS,
  ...LEGACY_ATTACHMENT_ROUTE_DEFINITIONS,
  ...PASSPORT_ROUTE_DEFINITIONS,
];
