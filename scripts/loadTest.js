const http = require("http");
const { performance } = require("perf_hooks");

const target = new URL(process.env.LOAD_TEST_URL || "http://127.0.0.1:5100/healthCheck");
const requests = Math.max(1, Number(process.env.LOAD_TEST_REQUESTS) || 500);
const concurrency = Math.max(1, Number(process.env.LOAD_TEST_CONCURRENCY) || 20);
const maximumP95 = Math.max(1, Number(process.env.LOAD_TEST_MAX_P95_MS) || 250);
const values = [];
let cursor = 0;
let failures = 0;

function once() {
  return new Promise((resolve) => {
    const started = performance.now();
    const request = http.request(target, { method: "GET", timeout: 5000 }, (response) => {
      response.resume();
      response.once("end", () => {
        values.push(performance.now() - started);
        if (response.statusCode >= 400) failures += 1;
        resolve();
      });
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", () => { failures += 1; resolve(); });
    request.end();
  });
}

async function worker() {
  while (cursor < requests) {
    cursor += 1;
    await once();
  }
}

function percentile(percent) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * percent / 100) - 1] : Infinity;
}

Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker)).then(() => {
  const result = { requests, concurrency, successes: values.length - failures, failures,
    p50Ms: Number(percentile(50).toFixed(2)), p95Ms: Number(percentile(95).toFixed(2)),
    p99Ms: Number(percentile(99).toFixed(2)) };
  console.log(JSON.stringify(result));
  if (failures || result.p95Ms > maximumP95) process.exitCode = 1;
});
