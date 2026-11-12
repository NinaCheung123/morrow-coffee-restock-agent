import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import express from "express";
import { interpret, interpretStay, modelConfigured } from "./interpret.js";
import { AMENITIES, CITY, HONOR_DAYS, HOTELS, StayError, StayService, StayStore, getHotelRules, hotelView, loadHotelRules, nightlyOfferCents, publicStay, resetHotelRules, setHotelRule } from "./stay.js";
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
const stayStore = new StayStore(join(process.env.DATA_DIR ?? "data", "stay-tasks.json"));
const stays = new StayService(stayStore, paypal, publicUrl);
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
// ---- Hotel stays ----
const hotelRulesPath = join(process.env.DATA_DIR ?? "data", "hotel-rules.json");
if (existsSync(hotelRulesPath)) try { loadHotelRules(JSON.parse(readFileSync(hotelRulesPath, "utf8"))); } catch { /* start from defaults */ }
const saveHotelRules = () => writeFileSync(hotelRulesPath, JSON.stringify(getHotelRules()), { mode: 0o600 });
const PREVIEW_DAYS = [30, 21, 14, 10, 7, 5, 3, 1, 0];
const hotelsView = () => HOTELS.map(h => { const rule = getHotelRules()[h.id]; return { id: h.id, name: h.name, connected: h.connected, stars: h.stars, simulated: true,
  listCents: h.listCents, taxBps: h.taxBps, amenities: h.amenities.map(a => AMENITIES[a]), rule,
  preview: PREVIEW_DAYS.map(d => ({ days: d, nightCents: nightlyOfferCents(h.listCents, rule, d) })), ...hotelView(stayStore.all(), h.id) }; });
app.get("/api/stay-config", (_req, res) => { res.json({ city: CITY, honorDays: HONOR_DAYS, amenities: AMENITIES, modelConnected: modelConfigured(),
  hotels: HOTELS.map(h => ({ id: h.id, name: h.name, connected: h.connected, stars: h.stars, listCents: h.listCents, amenities: h.amenities })) }); });
app.post("/api/stay-interpret", async (req, res) => {
  if (!modelConfigured()) { res.status(503).json({ error: "AI reading is not connected. Fill in the details yourself." }); return; }
  const text = typeof req.body?.request === "string" ? req.body.request.trim() : "";
  if (!text || text.length > 2500) throw new StayError("Describe the stay you want first.");
  if (Date.now() - aiWindow > 3600000) { aiWindow = Date.now(); aiCalls = 0; }
  if (++aiCalls > 60) { res.status(429).json({ error: "Demo AI limit reached. Fill in the details yourself or try again in an hour." }); return; }
  try { res.json(await interpretStay(text)); }
  catch { res.status(502).json({ error: "The AI could not read this request. Fill in the details yourself." }); }
});
app.post("/api/stays", (req, res) => {
  if (Date.now() - rateWindow > 3600000) { rateWindow = Date.now(); created = 0; }
  if (++created > 30) { res.status(429).json({ error: "Demo limit reached. Try again in an hour." }); return; }
  if (req.body?.confirmed !== true) throw new StayError("Confirm your booking rules first.");
  res.status(201).json(publicStay(stays.create(res.locals.owner, req.body.rules)));
});
app.get("/api/stays", (_req, res) => { res.json(stayStore.all().filter(t => t.owner === res.locals.owner).map(publicStay)); });
app.use("/api/stays/:id", (req, res, next) => {
  const t = stayStore.get(req.params.id);
  if (!t || t.owner !== res.locals.owner) { res.status(404).json({ error: "Booking not found in this browser session." }); return; }
  next();
});
app.get("/api/stays/:id", (req, res) => { res.json(publicStay(stayStore.get(req.params.id)!)); });
app.post("/api/stays/:id/ask", async (req, res) => { res.json(publicStay(await stays.ask(req.params.id, Number(req.body?.waitDays ?? 0)))); });
app.post("/api/stays/:id/book", async (req, res) => { res.json(publicStay(await stays.book(req.params.id))); });
app.post("/api/stays/:id/check", async (req, res) => { res.json(publicStay(await stays.finishApproval(req.params.id))); });
app.post("/api/stays/:id/advance", async (req, res) => { res.json(publicStay(await stays.advance(req.params.id, Number(req.body?.days)))); });
app.post("/api/stays/:id/checkin", async (req, res) => { res.json(publicStay(await stays.checkIn(req.params.id))); });
app.post("/api/stays/:id/cancel", async (req, res) => { res.json(publicStay(await stays.cancel(req.params.id, "guest"))); });
app.get("/api/hotels", (_req, res) => { res.json(hotelsView()); });
app.post("/api/hotels/reset", (_req, res) => { resetHotelRules(); saveHotelRules(); res.json(hotelsView()); });
app.post("/api/hotels/:id", (req, res) => { setHotelRule(req.params.id, req.body); saveHotelRules(); res.json(hotelsView()); });
// Hotel-side actions on a booking. The demo has no hotel sign-in, so anyone using it can press these.
app.post("/api/hotels/:id/bookings/:taskId/:action", async (req, res) => {
  const t = stayStore.get(req.params.taskId);
  if (!t || t.bookedOffer?.hotelId !== req.params.id) { res.status(404).json({ error: "Booking not found for this hotel." }); return; }
  if (req.params.action === "checkin") await stays.checkIn(t.id);
  else if (req.params.action === "cancel") await stays.cancel(t.id, "hotel");
  else { res.status(404).json({ error: "Unknown action" }); return; }
  res.json(hotelsView());
});
for (const path of ["stay-return", "stay-cancel"]) {
  app.get(`/paypal/${path}`, async (req, res) => {
    const id = typeof req.query.task === "string" ? req.query.task : "";
    const t = stayStore.get(id);
    if (!t || t.owner !== res.locals.owner || req.query.state !== t.callbackState) { res.status(403).send("Return to the browser session where you started your booking."); return; }
    try {
      if (path === "stay-cancel") await stays.cancel(id, "guest");
      else { if (req.query.token !== t.orderId) throw new StayError("Order mismatch"); await stays.finishApproval(id); }
      res.redirect(`/stay.html?task=${id}`);
    } catch { res.redirect(`/stay.html?task=${id}&notice=review`); }
  });
}
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error instanceof RestockError || error instanceof StayError ? 409 : 502).json({ error: error instanceof RestockError || error instanceof StayError ? error.message : "This action could not be completed. Check the task status before retrying." });
});
app.listen(port, process.env.HOST ?? (process.env.RENDER ? "0.0.0.0" : "127.0.0.1"), () => { console.log(`Coffee restock sandbox: ${publicUrl}`); });
