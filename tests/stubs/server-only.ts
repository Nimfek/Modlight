/**
 * Stand-in for Next's `server-only` package under Vitest.
 *
 * The real package exists to make a build FAIL when a server module is imported
 * into a client bundle; it has no runtime behaviour to reproduce. The tests run
 * outside Next, where nothing resolves it, so without this stub any module
 * carrying the guard is untestable - which would mean the guard discourages
 * exactly the code that most deserves tests.
 */
export {};
