// Step 58 (Reliability/Security/Monitoring): production metrics, exposed
// at GET /metrics for a Prometheus-compatible scraper. Uses
// @prometheus-io/client - the official Prometheus project's own Node.js
// client (github.com/prometheus/client_js, Apache-2.0), which replaced the
// long-standing community "prom-client" package (now deprecated upstream
// in favor of this one, confirmed via npm during this step's own research
// rather than assumed from the older package's larger install history)
// while keeping the identical API (Registry/Histogram/collectDefaultMetrics).

import * as client from "@prometheus-io/client";

export const metricsRegistry = new client.Registry();

// Standard Node.js process/runtime metrics (CPU, memory (RSS/heap),
// event-loop lag, active handles, GC) - a single well-known call rather
// than hand-instrumenting each of these, the same "don't reinvent what a
// real library already does correctly" reasoning already applied to
// choosing nodemailer over hand-rolled SMTP.
client.collectDefaultMetrics({ register: metricsRegistry });

// One histogram for every HTTP request this API serves, labeled by
// method/route/status - route (not the raw URL) is the templated pattern
// Fastify itself resolved the request to (e.g. "/v1/stations/:id"), never
// the literal path, so a metric never fans out into one time series per
// distinct id/value a caller happens to send - the same cardinality
// discipline Prometheus's own best-practice guidance requires.
export const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method/route/status_code",
  labelNames: ["method", "route", "status_code"],
  // Bucket boundaries chosen around this API's own documented latency
  // expectations: most routes are simple, indexed single-table lookups
  // (sub-10ms); POST /v1/voice/command is this API's own documented
  // heaviest single endpoint (up to four real queries per call,
  // backend/README.md's "Voice System" section) so the upper buckets
  // extend out to 2s rather than stopping at typical single-query timings.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [metricsRegistry],
});
