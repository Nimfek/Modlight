// Single merged schema barrel — the SAME object is passed to drizzle() and to
// Better Auth's drizzleAdapter(). Order doesn't matter; names must be unique.
export * from "./auth-schema"; // user, session, account, verification (+ plugin tables)
export * from "./app-schema"; // uploads, albums, tags, api_tokens, settings, audit_log
export * from "./duplicates-schema"; // duplicate_dismissals
