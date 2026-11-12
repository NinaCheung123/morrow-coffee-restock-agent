import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import express from "express";
import { interpret, modelConfigured } from "./interpret.js";
import { PayPalClient } from "./paypal.js";
import { readFileSync, writeFileSync } from "node:fs";
import { BRANDS, PRODUCTS, RestockError, RestockService, RestockStore, getOfferRules, loadOfferRules, publicTask, resetOfferRules, roasterInbox, setOfferRule } from "./restock.js";

if (existsSync(".env.sandbox")) process.loadEnvFile(".env.sandbox");
const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID?.trim();
const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) throw new Error("Set PayPal sandbox credentials in .env.sandbox");
const port = Number(process.env.PORT ?? 4030);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");
const paypal = new PayPalClient({ clientId, clientSecret });
const store = new RestockStore(join(process.env.DATA_DIR ?? "data", "coffee-tasks.json"));
const service = new RestockService(store, paypal, publicUrl);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "15kb" }));
app.use((req, res, next) => {
  res.set({ "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)coffee_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  res.locals.owner = cookie ?? randomUUID();
  if (!cookie) res.setHeader("Set-Cookie", `coffee_session=${res.locals.owner}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${publicUrl.startsWith("https:") ? "; Secure" : ""}`);
  if (!["GET", "HEAD"].includes(req.method) && req.headers.origin && req.headers.origin !== publicUrl) { res.status(403).json({ error: "Open this app at its configured address." }); return; }
  next();
});
app.use(express.static("public"));
const offersPath = join(process.env.DATA_DIR ?? "data", "offer-rules.json");
if (existsSync(offersPath)) try { loadOfferRules(JSON.parse(readFileSync(offersPath, "utf8"))); } catch { /* start from defaults */ }
const saveOffers = () => writeFileSync(offersPath, JSON.stringify(getOfferRules()), { mode: 0o600 });
const roasterView = () => BRANDS.map(b => ({ id: b.id, name: b.name, connected: b.connected, simulated: true,
  listCents: Math.min(...PRODUCTS.filter(p => p.brand === b.id).map(p => p.priceCents)), taxCentsPerBag: b.taxCentsPerBag,
  products: PRODUCTS.filter(p => p.brand === b.id).map(p => p.name), rule: getOfferRules()[b.id], inbox: roasterInbox(store.all(), b.id) }));
app.get("/api/roasters", (_req, res) => { res.json(roasterView()); });
app.post("/api/roasters/reset", (_req, res) => { resetOfferRules(); saveOffers(); res.json(roasterView()); });
app.post("/api/roasters/:id", (req, res) => { setOfferRule(req.params.id, req.body); saveOffers(); res.json(roasterView()); });
app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
let ping: { at: number; connected: boolean } | undefined;
app.get("/api/config", async (_req, res) => {
  if (!ping || Date.now() - ping.at > 60000) {
    try { await paypal.ping(); ping = { at: Date.now(), connected: true }; }
    catch { ping = { at: Date.now(), connected: false }; }
  }
  res.json({ brands: BRANDS, products: PRODUCTS, environment: "sandbox", connected: ping.connected, modelConnected: modelConfigured() });
});
let aiWindow = Date.now(); let aiCalls = 0;
app.post("/api/interpret", async (req, res) => {
  if (!modelConfigured()) { res.status(503).json({ error: "AI reading is not connected. Fill in the details yourself." }); return; }
  const text = typeof req.body?.request === "string" ? req.body.request.trim() : "";
  if (!text || text.length > 2500) throw new RestockError("Describe your coffee restock first.");
  if (Date.now() - aiWindow > 3600000) { aiWindow = Date.now(); aiCalls = 0; }
  if (++aiCalls > 60) { res.status(429).json({ error: "Demo AI limit reached. Fill in the details yourself or try again in an hour." }); return; }
  try { res.json(await interpret(text)); }
  catch { res.status(502).json({ error: "The AI could not read this request. Fill in the details yourself." }); }
});
let rateWindow = Date.now(); let created = 0;
app.post("/api/tasks", (req, res) => {
  if (Date.now() - rateWindow > 3600000) { rateWindow = Date.now(); created = 0; }
  if (++created > 30) { res.status(429).json({ error: "Demo limit reached. Try again in an hour." }); return; }
  if (req.body?.confirmed !== true) throw new RestockError("Confirm your purchase rules first.");
  res.status(201).json(publicTask(service.create(res.locals.owner, req.body.rules)));
});
app.get("/api/tasks", (_req, res) => { res.json(store.all().filter(t => t.owner === res.locals.owner).map(publicTask)); });
app.use("/api/tasks/:id", (req, res, next) => {
  const t = store.get(req.params.id);
  if (!t || t.owner !== res.locals.owner) { res.status(404).json({ error: "Task not found in this browser session." }); return; }
  next();
});
app.get("/api/tasks/:id", (req, res) => { res.json(publicTask(store.get(req.params.id)!)); });
app.post("/api/tasks/:id/consent", async (req, res) => { res.json(publicTask(await service.consent(req.params.id))); });
app.post("/api/tasks/:id/scan", async (req, res) => { res.json(publicTask(await service.scan(req.params.id))); });
app.post("/api/tasks/:id/checkout", async (req, res) => { res.json(publicTask(await service.checkout(req.params.id))); });
app.post("/api/tasks/:id/check", async (req, res) => { res.json(publicTask(await service.finishPayment(req.params.id))); });
app.post("/api/tasks/:id/cancel", async (req, res) => { res.json(publicTask(await service.cancel(req.params.id))); });
for (const path of ["return", "vault-return", "cancel"]) {
  app.get(`/paypal/${path}`, async (req, res) => {
    const id = typeof req.query.task === "string" ? req.query.task : "";
    const t = store.get(id);
    if (!t || t.owner !== res.locals.owner || req.query.state !== t.callbackState) { res.status(403).send("Return to the browser session where you started your coffee task."); return; }
    try {
      if (path === "cancel") await service.cancel(id);
      else if (path === "vault-return") {
        const updated = await service.finishConsent(id);
        if (updated.status === "ready") await service.scan(id);
      } else {
        if (req.query.token !== t.paymentOrderId) throw new RestockError("Order mismatch");
        await service.finishPayment(id);
      }
      res.redirect(`/?task=${id}`);
    } catch { res.redirect(`/?task=${id}&notice=review`); }
  });
}
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof RestockError ? 409 : 502).json({ error: error instanceof RestockError ? error.message : "This action could not be completed. Check the task status before retrying." });
});
app.listen(port, process.env.HOST ?? (process.env.RENDER ? "0.0.0.0" : "127.0.0.1"), () => { console.log(`Coffee restock sandbox: ${publicUrl}`); });
