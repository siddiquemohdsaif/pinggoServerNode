const { monitorEventLoopDelay, performance } = require("perf_hooks");

const MAX_SAMPLES = 2048;
const startedAt = Date.now();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
const samples = { http: [], database: [], websocketAck: [], attachment: [] };
const counters = new Map();

function increment(name, amount = 1) {
  counters.set(name, (counters.get(name) || 0) + amount);
}

function observe(name, milliseconds, labels = {}) {
  const bucket = samples[name];
  if (!bucket || !Number.isFinite(milliseconds)) return;
  bucket.push({ milliseconds, labels, at: Date.now() });
  if (bucket.length > MAX_SAMPLES) bucket.splice(0, bucket.length - MAX_SAMPLES);
}

function httpMiddleware(req, res, next) {
  const start = performance.now();
  res.once("finish", () => {
    observe("http", performance.now() - start, {
      method: req.method,
      route: req.route && req.route.path || req.path,
      status: res.statusCode,
    });
    increment(`http.status.${Math.floor(res.statusCode / 100)}xx`);
    if (res.statusCode >= 500) increment("errors.http");
  });
  next();
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1)].toFixed(2));
}

function distribution(items) {
  const values = items.map((item) => item.milliseconds);
  return { count: values.length, p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95), p99Ms: percentile(values, 99) };
}

function snapshot(extra = {}) {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    startedAt, uptimeSeconds: Math.round(process.uptime()),
    counters: Object.fromEntries(counters),
    latency: Object.fromEntries(Object.entries(samples).map(([name, values]) =>
      [name, distribution(values)])),
    eventLoop: {
      meanMs: Number((eventLoop.mean / 1e6).toFixed(2)),
      p95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
      p99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(2)),
      maxMs: Number((eventLoop.max / 1e6).toFixed(2)),
    },
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal, externalBytes: memory.external },
    cpu: { userMicros: cpu.user, systemMicros: cpu.system },
    ...extra,
  };
}

module.exports = { httpMiddleware, increment, observe, snapshot };
