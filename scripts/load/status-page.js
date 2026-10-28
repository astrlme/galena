// k6 load test of a status page through CloudFront: ramps to 10,000 requests a second over a
// minute and holds it for two, mostly the snapshot.json an open page polls. How to run it, and
// the results for Galena's own page: https://galena.astrl.me/docs/operations/performance/
import { check } from "k6";
import http from "k6/http";

const PAGE_URL = __ENV.GLN_PAGE_URL;
if (!PAGE_URL) {
  throw new Error(
    "GLN_PAGE_URL isn't set. Set it to the status page's address, such as https://status.example.com.",
  );
}
const RATE = Number(__ENV.GLN_RATE ?? 10_000);
if (!(RATE >= 1)) {
  throw new Error(
    `GLN_RATE is "${__ENV.GLN_RATE}". Set it to a number of requests a second, 1 or more.`,
  );
}

// Share of requests per path, out of 100.
const MIX = [
  ["/snapshot.json", 80],
  ["/", 10],
  ["/history/", 5],
  ["/api/v2/summary.json", 5],
];
const PATHS = MIX.flatMap(([path, share]) => Array(share).fill(path));

export const options = {
  scenarios: {
    page: {
      executor: "ramping-arrival-rate",
      exec: "visit",
      startRate: Math.min(100, RATE),
      timeUnit: "1s",
      preAllocatedVUs: 1_000,
      maxVUs: 4_000,
      stages: [
        { target: RATE, duration: "1m" },
        { target: RATE, duration: "2m" },
      ],
    },
  },
  thresholds: {
    // Any failed request fails the run; past 1% it stops early rather than keep sending.
    http_req_failed: [
      "rate==0",
      { threshold: "rate<0.01", abortOnFail: true, delayAbortEval: "10s" },
    ],
    dropped_iterations: ["count==0"],
  },
  // Spread connections over the edge addresses CloudFront's DNS hands out, as many visitors would.
  dns: { ttl: "1m", select: "random", policy: "preferIPv4" },
  discardResponseBodies: true,
  summaryTrendStats: ["med", "p(95)", "p(99)", "max"],
};

export function visit() {
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  const res = http.get(PAGE_URL + path, {
    headers: { "Accept-Encoding": "br, gzip" },
    tags: { name: path },
  });
  check(res, { "status is 200": (r) => r.status === 200 });
}
