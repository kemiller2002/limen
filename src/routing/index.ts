// @echelon-foundry/limen/routing — URL state for Limen engines (LCP-088..112).
//
// An engine library: pure functions an engine (TypeScript, or anything that
// runs JavaScript) uses to keep its navigable state in the URL. It never
// touches the browser. The kernel reports locations (Initialize.location,
// LocationChanged) and performs the Navigation effects this library decides.
// The semantics are conformance/routing/README.md; the F# library
// EchelonFoundry.Limen.Routing passes the same vectors.

export {
  adopt,
  allowAll,
  build,
  canonical,
  captureReturnTo,
  createRouteCodec,
  defineRoutes,
  destinations,
  hrefFor,
  initialRouterState,
  isRelativeLocation,
  isReservedName,
  locationFromBrowser,
  MAX_LOCATION_LENGTH,
  navigate,
  refine,
  replaceLocation,
  resolve,
  resumeReturnTo,
  RETURN_TO,
  routeOutcome,
  shareLink,
  signInLocation,
  splitLocation,
} from "./routing.js";

export type {
  Adopted,
  BuildError,
  DefinitionError,
  Guard,
  GuardDecision,
  LegacyRouteDefinition,
  Level,
  LocationMode,
  Moved,
  NavigationEffect,
  PageLocation,
  ParamType,
  Params,
  QueryParamDefinition,
  Resolution,
  Result,
  Roles,
  RouteCodec,
  RouteDefinition,
  RouteError,
  RouteMatch,
  RouterState,
  RouteTable,
  RouteValue,
  Target,
} from "./routing.js";

export { renderRouteInventory } from "./inventory.js";
