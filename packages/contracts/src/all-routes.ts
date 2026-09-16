import { ROUTE_DEFINITIONS as coreRoutes } from "./routes.js";
import { WEB_AI_ROUTE_DEFINITIONS } from "./web-ai.js";
export const ROUTE_DEFINITIONS = [...coreRoutes, ...WEB_AI_ROUTE_DEFINITIONS];
