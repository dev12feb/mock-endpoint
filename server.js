// =====================================================================
//  CPI Practice Target Server  (v3)
//  One server for all practice scenarios:
//    - OAuth2 client credentials  (+ Basic, API key, or no auth)
//    - Accepts JSON or XML, replies in the same format (or per Accept)
//    - Realistic Order structure with validation errors
//    - Switches (down / flaky / slow) you can flip without redeploying
// =====================================================================
const express = require("express");
const crypto = require("crypto");
const { XMLParser, XMLBuilder, XMLValidator } = require("fast-xml-parser");

const app = express();
app.set("trust proxy", true);
app.use(express.text({ type: () => true, limit: "5mb" })); // read ANY body as text

// ---------------------------------------------------------------------
// Configuration (override with Render environment variables)
// ---------------------------------------------------------------------
const env = process.env;
const CLIENT_ID = env.CLIENT_ID || "cpi-client";
const CLIENT_SECRET = env.CLIENT_SECRET || "cpi-secret";
const BASIC_USER = env.BASIC_USER || "cpiuser";
const BASIC_PASS = env.BASIC_PASS || "cpipass";
const API_KEY = env.API_KEY || "abc123";
const TOKEN_TTL = Number(env.TOKEN_TTL || 3600); // seconds
const TOKEN_KEY = env.TOKEN_SECRET || CLIENT_SECRET;
const ADMIN_KEY = env.ADMIN_KEY || ""; // if set, /admin and /logs need it

// Runtime switches (change via /admin, reset on restart)
const state = {
  authMode: (env.AUTH_MODE || "oauth").toLowerCase(), // oauth | basic | apikey | any | none
  down: false,                                        // true = every call returns 503
  flaky: Number(env.FLAKY || 0),                      // 0..1 = chance of random 503
  slowMs: Number(env.SLOW_MS || 70000),               // delay used by SLOW* orders
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const orders = new Map(); // in-memory "database"
const logs = [];          // last 50 requests

// ---------------------------------------------------------------------
// XML / JSON helpers
// ---------------------------------------------------------------------
const xmlParser = new XMLParser({
  parseTagValue: false,
  ignoreDeclaration: true,
  removeNSPrefix: true,
  trimValues: true,
  isArray: (name) => name.toLowerCase() === "item",
});
const xmlBuilder = new XMLBuilder({ format: true });

const bodyText = (req) => (typeof req.body === "string" ? req.body : "");
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v) => (v === undefined || v === null || String(v).trim() === "" ? NaN : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const asArray = (x) => (x === undefined || x === null || x === "" ? [] : Array.isArray(x) ? x : [x]);

function lowerKeys(v) {
  if (Array.isArray(v)) return v.map(lowerKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toLowerCase(), lowerKeys(x)]));
  return v;
}

function parseBody(req) {
  const body = bodyText(req).trim();
  if (!body) return {};
  const ct = (req.headers["content-type"] || "").toLowerCase();
  const isXml = ct.includes("xml") || (!ct.includes("json") && body.startsWith("<"));
  if (isXml) {
    const v = XMLValidator.validate(body);
    if (v !== true) throw new Error("Malformed XML: " + v.err.msg);
    return xmlParser.parse(body);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("Malformed JSON: " + e.message);
  }
}

// Reply in XML if client asks (Accept) or, when Accept is unclear, if it sent XML.
function wantsXml(req) {
  const accept = (req.headers["accept"] || "").toLowerCase();
  if (accept.includes("xml")) return true;
  if (accept.includes("json")) return false;
  const ct = (req.headers["content-type"] || "").toLowerCase();
  return ct.includes("xml") || (!ct.includes("json") && bodyText(req).trim().startsWith("<"));
}

// Same structure in both formats: JSON = { Root: {...} }, XML = <Root>...</Root>
function send(req, res, status, root, data) {
  res.status(status);
  if (wantsXml(req)) {
    res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\n' + xmlBuilder.build({ [root]: data }));
  } else {
    res.type("application/json").send(JSON.stringify({ [root]: data }));
  }
}

function fail(req, res, status, code, message, details) {
  const data = { Code: code, Message: message };
  if (details && details.length) data.Details = { Detail: details };
  send(req, res, status, "Error", data);
}

const baseUrl = (req) => `${req.protocol}://${req.get("host")}`;

// ---------------------------------------------------------------------
// Logging (secrets masked)
// ---------------------------------------------------------------------
app.use((req, res, next) => {
  if (["/", "/logs", "/health", "/favicon.ico"].includes(req.path)) return next();
  const h = { ...req.headers };
  if (h.authorization) h.authorization = String(h.authorization).split(" ")[0] + " ***";
  for (const k of ["x-api-key", "x-admin-key"]) if (h[k]) h[k] = "***";
  const entry = {
    time: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl.replace(/([?&]key=)[^&]*/, "$1***"),
    contentType: req.headers["content-type"],
    accept: req.headers["accept"],
    headers: h,
    body: req.path === "/oauth/token" ? "[masked]" : bodyText(req).slice(0, 5000),
  };
  logs.unshift(entry);
  if (logs.length > 50) logs.pop();
  res.on("finish", () => { entry.status = res.statusCode; });
  next();
});

// ---------------------------------------------------------------------
// OAuth2 token endpoint (client credentials)
// Stateless signed tokens: they stay valid even after Render restarts.
// ---------------------------------------------------------------------
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (p) => crypto.createHmac("sha256", TOKEN_KEY).update(p).digest("base64url");

function makeToken() {
  const p = Buffer.from(JSON.stringify({
    cid: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
    jti: crypto.randomBytes(6).toString("hex"),
  })).toString("base64url");
  return p + "." + sign(p);
}

function checkToken(t) { // returns null if valid, else a reason string
  const [p, s] = String(t).split(".");
  if (!p || !s) return "malformed token";
  if (!safeEq(s, sign(p))) return "invalid signature";
  let d;
  try { d = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return "malformed token"; }
  if (d.exp < Date.now() / 1000) return "token expired";
  return null;
}

function parseBasic(req) {
  const h = req.headers.authorization || "";
  if (!/^Basic\s/i.test(h)) return null;
  const raw = Buffer.from(h.replace(/^Basic\s+/i, ""), "base64").toString();
  const i = raw.indexOf(":");
  return i < 0 ? { user: raw, pass: "" } : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

app.post("/oauth/token", (req, res) => {
  let body = {};
  if ((req.headers["content-type"] || "").includes("json")) {
    try { body = JSON.parse(bodyText(req)); } catch { body = {}; }
  } else {
    body = Object.fromEntries(new URLSearchParams(bodyText(req)));
  }
  const grant = body.grant_type || req.query.grant_type;
  let id = body.client_id, secret = body.client_secret;
  const basic = parseBasic(req); // CPI "Send as Request Header" uses this
  if (basic) { id = basic.user; secret = basic.pass; }

  res.set("Cache-Control", "no-store");
  if (grant !== "client_credentials")
    return res.status(400).json({ error: "unsupported_grant_type", error_description: "Only client_credentials is supported" });
  if (!safeEq(id ?? "", CLIENT_ID) || !safeEq(secret ?? "", CLIENT_SECRET)) {
    res.set("WWW-Authenticate", 'Basic realm="token"');
    return res.status(401).json({ error: "invalid_client", error_description: "Client authentication failed" });
  }
  res.json({ access_token: makeToken(), token_type: "Bearer", expires_in: TOKEN_TTL, scope: "orders.read orders.write" });
});

// ---------------------------------------------------------------------
// Protection for /api and /sales-report: failure switches, then auth
// ---------------------------------------------------------------------
function simulateFailures(req, res, next) {
  if (state.down) {
    res.set("Retry-After", "10");
    return fail(req, res, 503, "SERVICE_DOWN", "Target system is down");
  }
  if (Math.random() < state.flaky) {
    res.set("Retry-After", "2");
    return fail(req, res, 503, "SERVICE_UNAVAILABLE", "Temporary failure, please retry");
  }
  next();
}

function authenticate(req, res, next) {
  const mode = state.authMode;
  if (mode === "none") return next();

  const h = req.headers.authorization || "";
  const got = {};
  if (/^Bearer\s/i.test(h)) {
    const reason = checkToken(h.replace(/^Bearer\s+/i, "").trim());
    got.bearer = { ok: !reason, reason };
  }
  const b = parseBasic(req);
  if (b) got.basic = { ok: safeEq(b.user, BASIC_USER) && safeEq(b.pass, BASIC_PASS) };
  if (req.headers["x-api-key"] !== undefined) got.key = { ok: safeEq(req.headers["x-api-key"], API_KEY) };

  const allowed = mode === "any" ? ["bearer", "basic", "key"] : [{ oauth: "bearer", basic: "basic", apikey: "key" }[mode] || "bearer"];
  if (allowed.some((m) => got[m] && got[m].ok)) return next();

  const challenges = [];
  let msg;
  if (allowed.includes("bearer")) {
    challenges.push(got.bearer ? `Bearer realm="api", error="invalid_token", error_description="${got.bearer.reason}"` : 'Bearer realm="api"');
    msg = got.bearer ? "Invalid access token: " + got.bearer.reason : "Missing Bearer access token";
  }
  if (allowed.includes("basic")) {
    challenges.push('Basic realm="api"');
    msg = got.basic ? "Invalid username or password" : "Missing Basic credentials";
  }
  if (allowed.includes("key")) {
    msg = got.key ? "Invalid x-api-key" : "Missing x-api-key header";
  }
  if (mode === "any") msg = "Authentication required (Bearer token, Basic or x-api-key)";
  if (challenges.length) res.set("WWW-Authenticate", challenges.join(", "));
  fail(req, res, 401, "UNAUTHORIZED", msg);
}

app.use(["/api", "/sales-report"], simulateFailures, authenticate);

// ---------------------------------------------------------------------
// Order handling
// ---------------------------------------------------------------------
const CURRENCIES = ["INR", "USD", "EUR", "GBP"];
const STATUSES = ["CREATED", "CONFIRMED", "SHIPPED", "CANCELLED"];

// Reads JSON or XML (wrapped in "Order" or not) and builds a clean order.
function buildOrder(req) {
  let n = lowerKeys(parseBody(req));
  if (n.order && typeof n.order === "object" && !Array.isArray(n.order)) n = n.order;

  const missing = [];  // -> 400
  const invalid = [];  // -> 422

  const orderId = str(n.orderid);
  if (!orderId) missing.push("OrderId is required");

  const c = n.customer;
  const cust = c && typeof c === "object" ? c : c ? { name: c } : {};
  const custName = str(cust.name);
  if (!custName) missing.push("Customer/Name is required");

  const rawItems = Array.isArray(n.items) ? n.items : asArray(n.items && n.items.item);
  if (rawItems.length === 0) missing.push("At least one Item is required (Items/Item)");

  const items = rawItems.map((it, i) => {
    const x = it && typeof it === "object" ? it : {};
    const label = `Item ${i + 1}`;
    const material = str(x.material);
    const qty = num(x.quantity);
    const price = num(x.unitprice);
    if (!material) missing.push(`${label}: Material is required`);
    if (!(qty > 0)) missing.push(`${label}: Quantity must be a number greater than 0`);
    if (!(price >= 0)) missing.push(`${label}: UnitPrice must be a number, 0 or more`);
    const out = { ItemNo: str(x.itemno) || String((i + 1) * 10), Material: material };
    if (str(x.description)) out.Description = str(x.description);
    out.Quantity = qty;
    out.UnitPrice = price;
    out.LineTotal = round2((qty || 0) * (price || 0));
    return out;
  });

  const currency = (str(n.currency) || "INR").toUpperCase();
  if (!CURRENCIES.includes(currency)) invalid.push(`Currency '${currency}' not supported. Use one of ${CURRENCIES.join(", ")}`);

  const country = str(cust.country);
  if (country && !/^[A-Z]{3}$/.test(country))
    invalid.push(`Customer/Country must be a 3-letter ISO code like IND, got '${country}'`);

  const orderDate = str(n.orderdate) || new Date().toISOString().slice(0, 10);
  if (isNaN(Date.parse(orderDate))) invalid.push(`OrderDate '${orderDate}' is not a valid date (use YYYY-MM-DD)`);

  const customer = { Id: str(cust.id) || undefined, Name: custName, Email: str(cust.email) || undefined, Country: country || undefined };
  Object.keys(customer).forEach((k) => customer[k] === undefined && delete customer[k]);

  return {
    missing,
    invalid,
    order: {
      OrderId: orderId,
      OrderDate: orderDate,
      Status: "CREATED",
      Currency: currency,
      Customer: customer,
      Items: { Item: items },
      TotalAmount: round2(items.reduce((s, it) => s + it.LineTotal, 0)),
      CreatedAt: new Date().toISOString(),
    },
  };
}

app.post("/api/orders", async (req, res) => {
  if (!bodyText(req).trim()) return fail(req, res, 400, "EMPTY_BODY", "Request body is empty");
  let r;
  try { r = buildOrder(req); } catch (e) { return fail(req, res, 400, "BAD_REQUEST", e.message); }
  if (r.missing.length) return fail(req, res, 400, "VALIDATION_ERROR", "Order validation failed", r.missing);
  if (r.invalid.length) return fail(req, res, 422, "UNPROCESSABLE_ENTITY", "Order has invalid values", r.invalid);

  const id = r.order.OrderId;
  // Special OrderId prefixes simulate target-side problems
  if (id.startsWith("FAIL")) return fail(req, res, 500, "INTERNAL_ERROR", "Unexpected error in target system");
  if (id.startsWith("BUSY")) { res.set("Retry-After", "5"); return fail(req, res, 503, "BUSY", "Target system is busy"); }
  if (orders.has(id)) return fail(req, res, 409, "DUPLICATE_ORDER", `Order ${id} already exists`);
  if (id.startsWith("SLOW")) await sleep(state.slowMs);

  orders.set(id, r.order);
  res.set("Location", `/api/orders/${encodeURIComponent(id)}`);
  send(req, res, 201, "Order", r.order);
});

// List with paging, filters and delta fetch:
//  ?top=5&skip=10  (or $top/$skip)  &status=CREATED  &customerId=C001  &createdAfter=2026-10-18T00:00:00Z
app.get("/api/orders", (req, res) => {
  const q = req.query;
  const toInt = (v, d) => { const x = parseInt(v, 10); return Number.isNaN(x) ? d : x; };
  const top = Math.min(Math.max(toInt(q.top ?? q["$top"], 10), 1), 100);
  const skip = Math.max(toInt(q.skip ?? q["$skip"], 0), 0);

  let list = [...orders.values()].sort((a, b) => a.CreatedAt.localeCompare(b.CreatedAt));
  if (q.status) list = list.filter((o) => o.Status === String(q.status).toUpperCase());
  if (q.customerId) list = list.filter((o) => o.Customer.Id === q.customerId);
  if (q.createdAfter) {
    const t = Date.parse(q.createdAfter);
    if (isNaN(t)) return fail(req, res, 400, "BAD_REQUEST", "createdAfter must be an ISO date-time, e.g. 2026-10-18T00:00:00Z");
    list = list.filter((o) => Date.parse(o.CreatedAt) > t);
  }

  const total = list.length;
  const page = list.slice(skip, skip + top);
  const data = { Count: total, Returned: page.length };
  if (skip + top < total) {
    const p = new URLSearchParams(q);
    p.delete("$top"); p.delete("$skip");
    p.set("top", top); p.set("skip", skip + top);
    data.Next = `${baseUrl(req)}/api/orders?${p.toString()}`;
  }
  data.Order = page;
  send(req, res, 200, "Orders", data);
});

app.get("/api/orders/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return fail(req, res, 404, "NOT_FOUND", `Order ${req.params.id} not found`);
  send(req, res, 200, "Order", o);
});

app.put("/api/orders/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return fail(req, res, 404, "NOT_FOUND", `Order ${req.params.id} not found`);
  let n;
  try { n = lowerKeys(parseBody(req)); } catch (e) { return fail(req, res, 400, "BAD_REQUEST", e.message); }
  if (n.order && typeof n.order === "object") n = n.order;
  const status = str(n.status).toUpperCase();
  if (!status) return fail(req, res, 400, "VALIDATION_ERROR", "Status is required");
  if (!STATUSES.includes(status)) return fail(req, res, 422, "UNPROCESSABLE_ENTITY", `Status must be one of ${STATUSES.join(", ")}`);
  o.Status = status;
  send(req, res, 200, "Order", o);
});

app.delete("/api/orders/:id", (req, res) => {
  if (!orders.delete(req.params.id)) return fail(req, res, 404, "NOT_FOUND", `Order ${req.params.id} not found`);
  res.status(204).end();
});

// Per-item stock/price check (use after a Splitter, then Gather the responses)
app.post("/api/items/check", (req, res) => {
  let n;
  try { n = lowerKeys(parseBody(req)); } catch (e) { return fail(req, res, 400, "BAD_REQUEST", e.message); }
  const one = Array.isArray(n.item) ? n.item[0] : n.item; // XML parser returns <Item> as a list
  if (one && typeof one === "object") n = one;
  const material = str(n.material);
  const qty = num(n.quantity);
  const errs = [];
  if (!material) errs.push("Material is required");
  if (!(qty > 0)) errs.push("Quantity must be a number greater than 0");
  if (errs.length) return fail(req, res, 400, "VALIDATION_ERROR", "Item validation failed", errs);
  if (material.toUpperCase().startsWith("OOS")) return fail(req, res, 422, "OUT_OF_STOCK", `Material ${material} is out of stock`);
  const price = 100 + ([...material].reduce((s, ch) => s + ch.charCodeAt(0), 0) % 900);
  send(req, res, 200, "ItemCheck", { Material: material, Quantity: qty, Available: true, UnitPrice: price, LineTotal: round2(price * qty) });
});

// Branches for Multicast / parallel calls:  /api/branch/ok  /api/branch/fail  /api/branch/slow
app.all("/api/branch/:name", async (req, res) => {
  const name = req.params.name.toLowerCase();
  if (name === "fail") return fail(req, res, 500, "BRANCH_FAILED", "Branch 'fail' always fails");
  if (name !== "ok" && name !== "slow") return fail(req, res, 404, "NOT_FOUND", "Use ok, fail or slow");
  if (name === "slow") await sleep(state.slowMs);
  send(req, res, 200, "Branch", { Name: name, Result: "OK", ProcessedAt: new Date().toISOString() });
});

// Lenient endpoint so the older iFlow (/sales-report) keeps working: accepts any body
app.post(["/sales-report", "/api/sales-report"], (req, res) => {
  send(req, res, 200, "SalesReport", {
    Status: "RECEIVED",
    ContentType: req.headers["content-type"] || "none",
    Bytes: Buffer.byteLength(bodyText(req)),
    ReceivedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------
// Admin: flip switches without redeploying
//   /admin?down=on|off   /admin?flaky=0.5   /admin?slowMs=10000
//   /admin?authMode=oauth|basic|apikey|any|none   /admin?reset=1
// ---------------------------------------------------------------------
function adminGuard(req, res, next) {
  if (ADMIN_KEY && req.headers["x-admin-key"] !== ADMIN_KEY && req.query.key !== ADMIN_KEY)
    return res.status(403).json({ error: "forbidden" });
  next();
}

app.get("/admin", adminGuard, (req, res) => {
  const q = req.query;
  if (q.authMode !== undefined) {
    const m = String(q.authMode).toLowerCase();
    if (!["oauth", "basic", "apikey", "any", "none"].includes(m))
      return res.status(400).json({ error: "authMode must be oauth, basic, apikey, any or none" });
    state.authMode = m;
  }
  if (q.down !== undefined) state.down = ["on", "true", "1"].includes(String(q.down).toLowerCase());
  if (q.flaky !== undefined) state.flaky = Math.min(Math.max(Number(q.flaky) || 0, 0), 1);
  if (q.slowMs !== undefined) state.slowMs = Math.max(Number(q.slowMs) || 0, 0);
  if (q.reset !== undefined) { orders.clear(); seed(); }
  res.json({ state, orders: orders.size, tokenTtlSeconds: TOKEN_TTL });
});

app.get("/logs", adminGuard, (req, res) => res.json(logs));
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/", (req, res) =>
  res.type("text/plain").send(`CPI practice target is running. Auth mode: ${state.authMode}. Token URL: /oauth/token  API: /api/orders`));

app.use((req, res) => fail(req, res, 404, "NO_ROUTE", "No such endpoint"));

// ---------------------------------------------------------------------
// Sample data, so GET / paging / delta fetch work from the first minute
// ---------------------------------------------------------------------
function seed() {
  const people = [
    ["C001", "Ravi Sharma", "ravi@example.com", "IND"],
    ["C002", "Asha Verma", "asha@example.com", "IND"],
    ["C003", "John Miller", "john@example.com", "USA"],
    ["C004", "Priya Singh", "priya@example.com", "IND"],
    ["C005", "Hans Mueller", "hans@example.com", "DEU"],
  ];
  const currencies = ["INR", "INR", "USD", "INR", "EUR"];
  const mats = [["MAT-001", "Laptop", 50000], ["MAT-002", "Mouse", 800], ["MAT-003", "Keyboard", 1500], ["MAT-004", "Monitor", 12000]];
  const now = Date.now();
  for (let i = 1; i <= 25; i++) {
    const c = (i - 1) % 5;
    const items = [];
    for (let k = 0; k < 1 + (i % 3); k++) {
      const m = mats[(i + k) % 4];
      const qty = 1 + ((i + k) % 3);
      items.push({ ItemNo: String((k + 1) * 10), Material: m[0], Description: m[1], Quantity: qty, UnitPrice: m[2], LineTotal: qty * m[2] });
    }
    const created = new Date(now - (26 - i) * 6 * 3600 * 1000).toISOString(); // one every 6 hours
    const id = "S" + String(i).padStart(4, "0");
    orders.set(id, {
      OrderId: id,
      OrderDate: created.slice(0, 10),
      Status: i % 4 === 0 ? "SHIPPED" : "CREATED",
      Currency: currencies[c],
      Customer: { Id: people[c][0], Name: people[c][1], Email: people[c][2], Country: people[c][3] },
      Items: { Item: items },
      TotalAmount: round2(items.reduce((s, it) => s + it.LineTotal, 0)),
      CreatedAt: created,
    });
  }
}
seed();

app.listen(env.PORT || 3000, () => console.log("CPI practice target running, auth mode: " + state.authMode));
