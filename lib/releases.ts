import "server-only";

/**
 * Server-guarded view of the release channel.
 *
 * Everything lives in ./releases-core; this module exists so the app keeps the
 * `server-only` guard (a release manifest reads settings and the uploads table,
 * and must never be pulled into a client bundle) while a bundled script can
 * import the core directly.
 */
export * from "./releases-core";
