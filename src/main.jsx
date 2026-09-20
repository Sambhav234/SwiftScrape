import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
const API_BASE = import.meta.env.VITE_API_URL || "";
const api = (p, o) =>
  fetch(`${API_BASE}${p}`, o).then((r) => {
    if (!r.ok) throw Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
function App() {
  const [tab, setTab] = useState("dashboard"),
    [items, setItems] = useState([]),
    [tracked, setTracked] = useState([]),
    [q, setQ] = useState(""),
    [selected, setSelected] = useState(null),
    [history, setHistory] = useState([]),
    [logs, setLogs] = useState([]),
    [state, setState] = useState("loading"),
    [searching, setSearching] = useState(false),
    [error, setError] = useState(""),
    [trackState, setTrackState] = useState({}),
    [scrapeDialog, setScrapeDialog] = useState(null),
    [theme, setTheme] = useState(
      () => localStorage.getItem("pricepulse-theme") || "light",
    );
  useEffect(() => {
    document.title = "SwiftScrape | Track product prices with confidence";
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pricepulse-theme", theme);
  }, [theme]);
  useEffect(() => {
    api(`/api/tracked`)
      .then((d) => setTracked(Array.isArray(d) ? d : d.items || []))
      .catch(() => setTracked([]));
  }, []);
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}`)
        .then((d) => {
          if (cancelled) return;
          setItems(d.items || []);
          setState("ready");
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e.message);
          setState("error");
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);
  const findTracked = (product) =>
    tracked.find(
      (item) =>
        String(item.id) === String(product.id) ||
        String(item.store_product_id) ===
          String(product.store_product_id || product.id),
    );
  const loadHistory = async (product) => {
    const saved = findTracked(product) || product;
    if (!saved?.id || !String(saved.id).includes("-")) {
      setHistory([]);
      return;
    }
    try {
      setHistory(await api(`/api/tracked/${saved.id}/history`));
    } catch (e) {
      setHistory([]);
      setError(`History could not load: ${e.message}`);
    }
  };

  const beginScrapeDialog = (product) =>
    setScrapeDialog({
      status: "running",
      productName: product.name,
      storeProductId: product.store_product_id || product.id,
    });
  const finishScrapeDialog = (product, result) => {
    const item = result?.results?.[0] || result;
    if (item?.outcome === "success") {
      setScrapeDialog({
        status: "success",
        productName: item.product_name || product.name,
        storeProductId:
          item.store_product_id || product.store_product_id || product.id,
        priceCents: item.price_cents,
        currency: item.currency || "INR",
        inStock: item.in_stock,
      });
    } else {
      setScrapeDialog({
        status: "failed",
        productName: item?.product_name || product.name,
        storeProductId:
          item?.store_product_id || product.store_product_id || product.id,
        errorCode: item?.error_code || "SCRAPE_FAILED",
        reason: item?.error || "The scraper did not return a valid price.",
      });
    }
  };

  const track = async (p) => {
    setError("");
    setTrackState((current) => ({ ...current, [p.id]: "Saving product..." }));
    try {
      const saved = await api("/api/tracked", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
      });
      setTracked((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setSelected(saved);
      setTab("detail");
      setHistory([]);
      setTrackState((current) => ({
        ...current,
        [p.id]: "Starting scrape...",
      }));
      beginScrapeDialog(saved);
      const result = await api(`/api/tracked/${saved.id}/scrape`, {
        method: "POST",
      });
      finishScrapeDialog(saved, result);
      const historyRows = await api(`/api/tracked/${saved.id}/history`);
      setHistory(historyRows);
      setTrackState((current) => ({
        ...current,
        [p.id]:
          result.results?.[0]?.outcome === "success"
            ? "Price recorded"
            : "Scrape failed; see Logs",
      }));
      await api(`/api/tracked/${saved.id}/logs`)
        .then(setLogs)
        .catch(() => {});
    } catch (e) {
      setError(e.message);
      setScrapeDialog({
        status: "failed",
        productName: p.name,
        storeProductId: p.store_product_id || p.id,
        errorCode: "REQUEST_FAILED",
        reason: e.message,
      });
      setTrackState((current) => ({ ...current, [p.id]: "Tracking failed" }));
    }
  };
  const scrapeTracked = async (product) => {
    setError("");
    setTrackState((current) => ({ ...current, [product.id]: "Scraping..." }));
    beginScrapeDialog(product);
    try {
      const result = await api(`/api/tracked/${product.id}/scrape`, {
        method: "POST",
      });
      finishScrapeDialog(product, result);
      setHistory(await api(`/api/tracked/${product.id}/history`));
      await api(`/api/tracked/${product.id}/logs`)
        .then(setLogs)
        .catch(() => {});
      setTrackState((current) => ({
        ...current,
        [product.id]:
          result.results?.[0]?.outcome === "success"
            ? "Price recorded"
            : "Scrape failed; see Logs",
      }));
    } catch (e) {
      setError(e.message);
      setScrapeDialog({
        status: "failed",
        productName: product.name,
        storeProductId: product.store_product_id || product.id,
        errorCode: "REQUEST_FAILED",
        reason: e.message,
      });
      setTrackState((current) => ({
        ...current,
        [product.id]: "Scrape failed",
      }));
    }
  };
  const open = (p) => {
    const saved = findTracked(p);
    setSelected(saved || p);
    setTab("detail");
    loadHistory(saved || p);
  };
  useEffect(() => {
    if (tab === "logs")
      api("/api/logs")
        .then(setLogs)
        .catch(() => setLogs([]));
    if (tab === "history") {
      const product = selected || tracked[0];
      if (product) loadHistory(product);
    }
  }, [tab, selected, tracked]);
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">SwiftScrape · PRODUCT PRICE TRACKER</p>
          <h1>Know the price before it moves.</h1>
          <p className="sub">
            Search the catalog, save products you care about, and see verified
            price observations in one calm workspace.
          </p>
        </div>
        <input
          aria-label="Search products"
          placeholder="Search products by name, brand, or category…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className="theme-toggle"
          type="button"
          onClick={() =>
            setTheme((current) => (current === "light" ? "dark" : "light"))
          }
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
          {theme === "light" ? "Dark mode" : "Light mode"}
        </button>
        {searching && (
          <span className="search-loader" role="status" aria-live="polite">
            <span className="spinner" /> Searching…
          </span>
        )}
      </header>
      <section className="trust-strip" aria-label="PricePulse benefits">
        <span>
          <b>01</b> Search the catalog
        </span>
        <span>
          <b>02</b> Track products you care about
        </span>
        <span>
          <b>03</b> Review verified price changes
        </span>
      </section>
      <nav aria-label="Main navigation">
        {[
          ["dashboard", "Browse products"],
          ["detail", "Selected product"],
          ["history", "Price history"],
          ["logs", "All scrape activity"],
        ].map(([id, label]) => (
          <button
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
            key={id}
          >
            {label}
          </button>
        ))}
      </nav>
      {state === "loading" && <p className="status">Loading catalog…</p>}
      {state === "error" && <p className="error">Unable to load: {error}</p>}
      {tab === "dashboard" && (
        <>
          <section className="welcome-panel">
            <div>
              <span className="tag">YOUR PRICE WORKSPACE</span>
              <h2>Track less. Understand more.</h2>
              <p>
                Choose a product below to open its own workspace. History and
                scrape results always belong to the product you selected.
              </p>
            </div>
            <div className="stats" aria-label="Tracker summary">
              <div>
                <strong>{tracked.length}</strong>
                <span>Tracked products</span>
              </div>
              <div>
                <strong>{items.length}</strong>
                <span>Catalog results</span>
              </div>
              <div>
                <strong>
                  {logs.filter((log) => log.outcome === "success").length}
                </strong>
                <span>Successful checks</span>
              </div>
            </div>
          </section>
          {tracked.length > 0 && (
            <section className="content-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">YOUR LIST</span>
                  <h2>Tracked products</h2>
                </div>
                <span className="muted">{tracked.length} saved</span>
              </div>
              <div className="tracked-strip">
                {tracked.map((product) => (
                  <button
                    className="tracked-chip"
                    key={product.id}
                    onClick={() => open(product)}
                  >
                    <span>{product.name}</span>
                    <small>Open workspace →</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="content-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">CATALOG</span>
                <h2>{q ? "Search results" : "Explore products"}</h2>
              </div>
              <span className="muted">
                {searching
                  ? "Searching…"
                  : `${items.length} ${items.length === 1 ? "product" : "products"}`}
              </span>
            </div>
            <div className="grid">
              {searching ? (
                <div className="searching-state">
                  <span className="large-spinner" />
                  <h2>Searching products…</h2>
                  <p>Finding the best matches for “{q}”.</p>
                </div>
              ) : (
                items.map((p) => (
                  <article className="card" key={p.id}>
                    <div className="card-topline">
                      <span className="tag">{p.category || "Product"}</span>
                      <span className="product-id">ID {p.id}</span>
                    </div>
                    <h2>{p.name}</h2>
                    <p className="brand">
                      {p.brand} · {p.sku}
                    </p>
                    <p>
                      {p.description?.slice(0, 120)}
                      {p.description?.length > 120 ? "…" : ""}
                    </p>
                    <div className="card-actions">
                      <button
                        className="secondary-button"
                        onClick={() => open(p)}
                      >
                        View product
                      </button>
                      <button className="track-button" onClick={() => track(p)}>
                        {trackState[p.id] || "Track price"}
                      </button>
                    </div>
                  </article>
                ))
              )}
              {state === "ready" && !searching && !items.length && (
                <div className="empty-state">
                  <span className="empty-icon">⌕</span>
                  <h2>No results found</h2>
                  <p>
                    No products matched “{q}”. Try a different name, brand, or
                    category.
                  </p>
                </div>
              )}
            </div>
          </section>
        </>
      )}
      {tab === "detail" && (
        <section className="product-workspace panel">
          {selected ? (
            <>
              <div className="workspace-heading">
                <div>
                  <span className="eyebrow">SELECTED PRODUCT WORKSPACE</span>
                  <span className="tag">{selected.category || "Product"}</span>
                  <h2>{selected.name}</h2>
                  <p>{selected.description}</p>
                </div>
                <button
                  className="track-button"
                  onClick={() =>
                    findTracked(selected)
                      ? scrapeTracked(findTracked(selected))
                      : track(selected)
                  }
                >
                  {findTracked(selected)
                    ? "Scrape latest price"
                    : "Track this product"}
                </button>
              </div>
              <div className="workspace-links">
                <button onClick={() => setTab("history")}>
                  View this product's full history →
                </button>
                <button onClick={() => setTab("logs")}>
                  View this product's scrape activity →
                </button>
              </div>
              <h3>Latest price observations for {selected.name}</h3>
              <PriceChart rows={history} productName={selected.name} />
              <Rows rows={history} />
            </>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">⌕</span>
              <h2>No product selected</h2>
              <p>
                Go to Browse products and choose “View product” to open a
                product-specific workspace.
              </p>
              <button
                className="secondary-button"
                onClick={() => setTab("dashboard")}
              >
                Browse products
              </button>
            </div>
          )}
        </section>
      )}
      {tab === "history" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">PRODUCT-SPECIFIC VIEW</span>
              <h2>
                {selected
                  ? `${selected.name} · Price history`
                  : "Price history"}
              </h2>
            </div>
            <span className="scope-badge">
              {selected ? "Selected product" : "No product selected"}
            </span>
          </div>
          {!selected && !tracked.length ? (
            <div className="empty-state">
              <h2>History appears after you track a product</h2>
              <p>
                This page shows observations for one selected product, not the
                whole catalog.
              </p>
              <button
                className="secondary-button"
                onClick={() => setTab("dashboard")}
              >
                Find a product
              </button>
            </div>
          ) : !selected ? (
            <div className="empty-state">
              <h2>Select a product to see its history</h2>
              <p>Open a tracked product from Browse products first.</p>
            </div>
          ) : (
            <>
              <PriceChart rows={history} productName={selected.name} />
              <Rows rows={history} />
            </>
          )}
        </section>
      )}
      {tab === "logs" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">SYSTEM ACTIVITY</span>
              <h2>
                {selected
                  ? `${selected.name} · Scrape activity`
                  : "All scrape activity"}
              </h2>
            </div>
            <span className="scope-badge">
              {selected ? "Selected product" : "All tracked products"}
            </span>
          </div>
          <p className="section-intro">
            {selected
              ? "Every attempt made to collect a price for this product."
              : "A combined operational view of scrape attempts across all tracked products."}
          </p>
          {(selected
            ? logs.filter(
                (log) =>
                  String(log.product_id) === String(selected.id) ||
                  String(log.store_product_id) ===
                    String(selected.store_product_id),
              )
            : logs
          ).length ? (
            <div className="log-list">
              {(selected
                ? logs.filter(
                    (log) =>
                      String(log.product_id) === String(selected.id) ||
                      String(log.store_product_id) ===
                        String(selected.store_product_id),
                  )
                : logs
              ).map((log, index) => {
                const product = log.parsed_snapshot?.product;
                return (
                  <article
                    className={`log-entry ${log.outcome || "failed"}`}
                    key={log.id || index}
                  >
                    <div>
                      <strong>
                        {log.product_name ||
                          product?.name ||
                          `Product ID ${log.product_id}`}
                      </strong>
                      <span className="log-outcome">
                        {log.outcome || "unknown"}
                      </span>
                    </div>
                    <small>
                      {new Date(log.started_at).toLocaleString()} ·{" "}
                      {log.trigger} · {log.attempts} attempt(s) ·{" "}
                      {log.duration_ms ?? "?"} ms
                    </small>
                    <small>
                      Store product:{" "}
                      {log.store_product_id || product?.id || "unknown"}
                    </small>
                    {log.error_code && (
                      <p>
                        <b>{log.error_code}:</b>{" "}
                        {log.error_message || "No error message recorded"}
                      </p>
                    )}
                    {log.outcome === "success" && (
                      <p>Validated price observation recorded.</p>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              <h2>No scrape activity yet</h2>
              <p>
                {selected
                  ? "This product has not been scraped yet. Start a check from its workspace."
                  : "Scrape activity will appear here after you track a product."}
              </p>
            </div>
          )}
        </section>
      )}
      {scrapeDialog && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className={`scrape-dialog ${scrapeDialog.status}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="scrape-dialog-title"
          >
            <div className="dialog-header">
              <span className="dialog-kicker">PRICE TRACKER</span>
              <button
                className="dialog-close"
                onClick={() => setScrapeDialog(null)}
                aria-label="Hide scrape result"
              >
                Close
              </button>
            </div>
            <h2 id="scrape-dialog-title">
              {scrapeDialog.status === "running"
                ? "Currently scraping"
                : scrapeDialog.status === "success"
                  ? "Price scraped successfully"
                  : "Price scraping failed"}
            </h2>
            <p className="dialog-product">{scrapeDialog.productName}</p>
            {scrapeDialog.status === "running" && (
              <p className="dialog-message">
                <span className="spinner" /> Opening the store page, revealing
                the price, and validating stock. Please wait.
              </p>
            )}
            {scrapeDialog.status === "success" && (
              <div className="dialog-result">
                <strong>
                  {scrapeDialog.currency}{" "}
                  {((scrapeDialog.priceCents || 0) / 100).toFixed(2)}
                </strong>
                <span>
                  {scrapeDialog.inStock ? "In stock" : "Out of stock"}
                </span>
              </div>
            )}
            {scrapeDialog.status === "failed" && (
              <div className="dialog-failure">
                <strong>{scrapeDialog.errorCode}</strong>
                <p>{scrapeDialog.reason}</p>
              </div>
            )}
            {scrapeDialog.status !== "running" && (
              <button
                className="track-button dialog-hide"
                onClick={() => setScrapeDialog(null)}
              >
                Hide
              </button>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
function PriceChart({ rows, productName }) {
  const points = rows
    .filter((row) => row.price_cents != null || row.price != null)
    .map((row) => ({
      price: row.price_cents ?? row.price,
      date: row.scraped_at || row.started_at || row.created_at,
      currency: row.currency || "INR",
    }))
    .filter((row) => Number.isFinite(Number(row.price)))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!points.length) {
    return (
      <div className="chart-empty">
        <span className="chart-empty-icon">↗</span>
        <div>
          <strong>Price trend will appear after a successful scrape</strong>
          <p>There are no valid price observations for {productName} yet.</p>
        </div>
      </div>
    );
  }

  const width = 760;
  const height = 260;
  const padding = { top: 28, right: 24, bottom: 42, left: 64 };
  const values = points.map((point) => Number(point.price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(max * 0.1, 100);
  const x = (index) =>
    padding.left +
    (index * (width - padding.left - padding.right)) /
      Math.max(points.length - 1, 1);
  const y = (value) =>
    padding.top +
    ((max - value) * (height - padding.top - padding.bottom)) / range;
  const path = points
    .map((point, index) => `${index ? "L" : "M"} ${x(index)} ${y(point.price)}`)
    .join(" ");
  const first = values[0];
  const latest = values[values.length - 1];
  const change = latest - first;
  const changePercent = first ? (change / first) * 100 : 0;
  const formatPrice = (value) =>
    `${points[points.length - 1].currency} ${(value / 100).toLocaleString(
      undefined,
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    )}`;
  const formatDate = (value) =>
    new Date(value).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  const gridValues = [max, max - range / 2, min];

  return (
    <section
      className="price-chart"
      aria-label={`Price trend for ${productName}`}
    >
      <div className="chart-header">
        <div>
          <span className="eyebrow">PRICE TREND</span>
          <h3>{productName}</h3>
          <p>
            {points.length} verified observation
            {points.length === 1 ? "" : "s"} over time
          </p>
        </div>
        <div className="chart-summary">
          <strong>{formatPrice(latest)}</strong>
          <span
            className={
              change > 0
                ? "price-up"
                : change < 0
                  ? "price-down"
                  : "price-flat"
            }
          >
            {change === 0
              ? "No change"
              : `${change > 0 ? "+" : ""}${changePercent.toFixed(1)}% since first check`}
          </span>
        </div>
      </div>
      <div className="chart-scroll">
        <svg
          className="price-chart-svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Price changed from ${formatPrice(first)} to ${formatPrice(latest)}`}
        >
          {gridValues.map((value, index) => (
            <g key={value}>
              <line
                className="chart-gridline"
                x1={padding.left}
                x2={width - padding.right}
                y1={y(value)}
                y2={y(value)}
              />
              <text
                className="chart-axis-label"
                x={padding.left - 10}
                y={y(value) + 4}
                textAnchor="end"
              >
                {formatPrice(value)}
              </text>
            </g>
          ))}
          <line
            className="chart-axis"
            x1={padding.left}
            x2={width - padding.right}
            y1={height - padding.bottom}
            y2={height - padding.bottom}
          />
          <path className="chart-line" d={path} />
          {points.map((point, index) => (
            <circle
              className="chart-point"
              key={`${point.date}-${index}`}
              cx={x(index)}
              cy={y(point.price)}
              r={index === points.length - 1 ? 5 : 4}
            >
              <title>
                {`${formatPrice(point.price)} · ${new Date(point.date).toLocaleString()}`}
              </title>
            </circle>
          ))}
          <text
            className="chart-date-label"
            x={padding.left}
            y={height - 14}
          >
            {formatDate(points[0].date)}
          </text>
          <text
            className="chart-date-label"
            x={width - padding.right}
            y={height - 14}
            textAnchor="end"
          >
            {formatDate(points[points.length - 1].date)}
          </text>
        </svg>
      </div>
    </section>
  );
}
function Rows({ rows }) {
  return rows.length ? (
    <div className="rows">
      {rows.map((r, i) => (
        <div className="row" key={r.id || i}>
          <strong>
            {r.price_cents == null && r.price == null
              ? "No valid price"
              : `${r.currency || "INR"} ${((r.price_cents ?? r.price) / 100).toFixed(2)}`}
          </strong>
          <small>
            {r.outcome || r.status || r.message || "ok"} ·{" "}
            {new Date(
              r.scraped_at || r.started_at || r.created_at,
            ).toLocaleString()}
          </small>
        </div>
      ))}
    </div>
  ) : (
    <p className="status">No observations yet.</p>
  );
}
createRoot(document.getElementById("root")).render(<App />);
