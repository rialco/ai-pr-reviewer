/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as bootstrap from "../bootstrap.js";
import type * as githubComments from "../githubComments.js";
import type * as jobs from "../jobs.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_machineAuth from "../lib/machineAuth.js";
import type * as machines from "../machines.js";
import type * as prs from "../prs.js";
import type * as repos from "../repos.js";
import type * as reviews from "../reviews.js";
import type * as settings from "../settings.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  bootstrap: typeof bootstrap;
  githubComments: typeof githubComments;
  jobs: typeof jobs;
  "lib/auth": typeof lib_auth;
  "lib/machineAuth": typeof lib_machineAuth;
  machines: typeof machines;
  prs: typeof prs;
  repos: typeof repos;
  reviews: typeof reviews;
  settings: typeof settings;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
