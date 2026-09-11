import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // These are integration tests against one real, shared Postgres
    // instance (no per-file database, no transactional test isolation) -
    // most tables are only ever touched through unique per-test-run values
    // (a fresh email per test), so cross-file parallelism was safe. The
    // email_outbox table breaks that: its worker claims *any* pending row
    // regardless of which test enqueued it, so two files' outbox tests
    // running concurrently can race for the same rows. Serializing file
    // execution removes that whole class of nondeterminism outright,
    // rather than papering over it with timing-dependent assertions.
    fileParallelism: false,
  },
});
