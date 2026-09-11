process.env.DATABASE_URL ??= "postgres://caribbean:caribbean@localhost:5432/caribbean_radio_hub_test";
process.env.JWT_SECRET ??= "test-only-secret-not-for-production-use-0123456789";
// A single, fixed bootstrap-admin address so tests/adminRole.test.ts can
// prove the real registration/login routes actually promote a listed email
// to 'admin' end-to-end, not just the underlying repository function in
// isolation. No other test registers this exact address.
process.env.ADMIN_EMAILS ??= "bootstrap-admin@example.com";
