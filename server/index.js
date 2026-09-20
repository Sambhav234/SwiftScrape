import "dotenv/config";
import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import crypto from "node:crypto";
import {
  collectMetadata,
  fetchProduct,
  fetchLayout,
  revealPrice,
  validateObservation,
} from "./scraper.js";
import {
  db,
  upsertProducts,
  query,
  mutateTracked,
  acquireScrapeLock,
  releaseScrapeLock,
  insertScrapeLog,
  insertPriceHistory,
  updateTrackedProduct,
} from "./db.js";

const app = express(),
  port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (existsSync(dist)) app.use(express.static(dist));

let running = false,
  runId = null,
  catalogCache = null,
  catalogCacheAt = 0;

app.get("/api/health", (req, r) => {
  // Support a bare health probe with no body to keep cron/health pings small
  if (req.query.bare) return r.sendStatus(204);
  return r.json({ ok: true, service: "price-tracker", scrapeRunning: running });
});
app.get("/health", (_, r) => r.redirect("/api/health"));

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").toLowerCase();
    const now = Date.now();
    if (!catalogCache || now - catalogCacheAt > 120000) {
      catalogCache = await collectMetadata();
      catalogCacheAt = now;
    }
    res.json({
      items: catalogCache.filter(
        (p) =>
          !q ||
          `${p.name} ${p.brand || ""} ${p.category || ""} ${p.sku || ""} ${p.description || ""}`
            .toLowerCase()
            .includes(q),
      ),
    });
  } catch (e) {
    console.error("Search error:", e);
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/tracked", async (_, r) => {
  try {
    r.json(await query("tracked_products", { order: "created_at" }));
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.post("/api/tracked", async (req, r) => {
  try {
    const p = req.body;
    if (!p?.id || !p?.name)
      return r.status(400).json({ error: "id and name are required" });
    r.status(201).json(await mutateTracked("insert", p));
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.delete("/api/tracked/:id", async (req, r) => {
  try {
    r.json(await mutateTracked("delete", {}, req.params.id));
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.get("/api/tracked/:id/history", async (req, r) => {
  try {
    r.json(
      await query("price_history", {
        eq: { product_id: req.params.id },
        order: "scraped_at",
        limit: 200,
      }),
    );
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.get("/api/history/:id", async (req, r) => {
  try {
    r.json(
      await query("price_history", {
        eq: { product_id: req.params.id },
        order: "scraped_at",
        limit: 200,
      }),
    );
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.get("/api/history", async (_, r) => {
  try {
    r.json(await query("price_history", { order: "scraped_at", limit: 200 }));
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.get("/api/tracked/:id/logs", async (req, r) => {
  try {
    r.json(
      await query("scrape_logs", {
        eq: { product_id: req.params.id },
        order: "started_at",
        limit: 200,
      }),
    );
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.get("/api/logs", async (_, r) => {
  try {
    const [logs, products] = await Promise.all([
      query("scrape_logs", { order: "started_at", limit: 200 }),
      query("tracked_products", { limit: 1000 }),
    ]);
    const byId = new Map(products.map((product) => [product.id, product]));
    r.json(
      logs.map((log) => ({
        ...log,
        product_name:
          byId.get(log.product_id)?.name ||
          log.parsed_snapshot?.product?.name ||
          null,
        store_product_id:
          byId.get(log.product_id)?.store_product_id ||
          log.parsed_snapshot?.product?.id ||
          null,
      })),
    );
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

async function scrapeProducts(products, trigger = "cron") {
  const scrapeRunId = crypto.randomUUID();
  const results = [];
  for (const product of products) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let log;
    let attempts = 0;
    try {
      let revealed;
      let lastError;
      const maxAttempts = Number(process.env.SCRAPE_MAX_ATTEMPTS || 3);
      for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
        try {
          revealed = await revealPrice(product.store_product_id, {
            headless: true,
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempts < maxAttempts)
            await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
        }
      }
      if (!revealed) throw lastError || new Error("Price reveal failed");
      const observation = validateObservation({
        price: revealed.raw || revealed.price,
        stock: revealed.stock,
      });
      if (!observation.valid || observation.stock === null) {
        throw Object.assign(
          new Error(observation.reason || "Invalid observation"),
          { code: "VALIDATION_FAILED" },
        );
      }
      log = await insertScrapeLog({
        product_id: product.id,
        run_id: scrapeRunId,
        trigger,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        outcome: "success",
        attempts,
        duration_ms: Date.now() - started,
        parsed_snapshot: revealed,
      });
      await insertPriceHistory({
        product_id: product.id,
        price_cents: observation.price,
        currency: "INR",
        in_stock: observation.stock === "in_stock",
        scraped_at: new Date().toISOString(),
        log_id: log.id,
      });
      await updateTrackedProduct(product.id, {
        last_scraped_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
      });
      results.push({
        product_id: product.id,
        product_name: product.name,
        store_product_id: product.store_product_id,
        outcome: "success",
        price_cents: observation.price,
        currency: "INR",
        in_stock: observation.stock === "in_stock",
      });
    } catch (error) {
      await insertScrapeLog({
        product_id: product.id,
        run_id: scrapeRunId,
        trigger,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        outcome: "failed",
        attempts,
        error_code: error.code || "SCRAPE_FAILED",
        error_message: `[${product.name} | store ID ${product.store_product_id}] ${error.message}`,
        duration_ms: Date.now() - started,
        parsed_snapshot: {
          product: { id: product.store_product_id, name: product.name },
          stage: "price_reveal_or_validation",
        },
      });
      await updateTrackedProduct(product.id, {
        last_scraped_at: new Date().toISOString(),
      });
      results.push({
        product_id: product.id,
        product_name: product.name,
        store_product_id: product.store_product_id,
        outcome: "failed",
        error_code: error.code || "SCRAPE_FAILED",
        error: error.message,
      });
    }
  }
  return { runId: scrapeRunId, results };
}

async function scrape() {
  if (running) return { skipped: true, runId };
  const candidate = crypto.randomUUID();
  if (!(await acquireScrapeLock(candidate)))
    return { skipped: true, runId: null };
  running = true;
  runId = candidate;
  const started = Date.now();
  try {
    const tracked = await query("tracked_products", {
      eq: { active: true },
      order: "created_at",
    });
    if (!tracked.length)
      return { runId, count: 0, message: "No active tracked products" };
    return await scrapeProducts(tracked, "cron");
  } finally {
    await releaseScrapeLock();
    running = false;
    runId = null;
    console.log(`scrape ${Date.now() - started}ms`);
  }
}

function cronHandler(req, r) {
  if (
    !process.env.CRON_SECRET ||
    req.get("x-cron-secret") !== process.env.CRON_SECRET
  )
    return r.status(401).json({ error: "Unauthorized" });
  r.set("Cache-Control", "no-store");
  r.set("Content-Length", "8");
  if (running) return r.status(202).type("text/plain").send("accepted");
  scrape().catch((e) => console.error(e));
  return r.status(202).type("text/plain").send("accepted");
}

app.post("/api/cron/scrape", cronHandler);
app.post("/api/tracked/:id/scrape", async (req, res) => {
  try {
    const products = await query("tracked_products", {
      eq: { id: req.params.id },
      limit: 1,
    });
    if (!products.length)
      return res.status(404).json({ error: "Tracked product not found" });
    res
      .status(202)
      .json({ accepted: true, ...(await scrapeProducts(products, "manual")) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/cron/collect", (req, r) => {
  if (req.headers.authorization) {
    req.headers["x-cron-secret"] = req.headers.authorization.includes(" ")
      ? req.headers.authorization.slice(
          req.headers.authorization.indexOf(" ") + 1,
        )
      : req.headers.authorization;
  }
  cronHandler(req, r);
});

app.post("/api/products/:id/reveal", async (req, r) => {
  try {
    r.json(await revealPrice(req.params.id));
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.get("/api/layout", async (_, r) => {
  try {
    r.json(await fetchLayout());
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

app.get("/api/products/:id", async (req, r) => {
  try {
    r.json(await fetchProduct(req.params.id));
  } catch (e) {
    r.status(502).json({ error: e.message });
  }
});

if (process.env.NODE_ENV !== "test")
  app.listen(port, () => console.log(`API listening on ${port}`));

export { app, scrape };
