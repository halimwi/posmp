"use strict";

// ---------------------------------------------------------------------------
// Config + tiny API client
// ---------------------------------------------------------------------------

const api = {
  base() {
    const fromConfig = window.POSMP_CONFIG && window.POSMP_CONFIG.apiUrl;
    return (fromConfig || localStorage.getItem("posmp_api") || "").replace(/\/+$/, "");
  },
  setBase(url) {
    localStorage.setItem("posmp_api", url.replace(/\/+$/, ""));
  },
  token() {
    return localStorage.getItem("posmp_token") || "";
  },
  async request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    const t = this.token();
    if (t) headers.Authorization = "Bearer " + t;
    const res = await fetch(this.base() + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && path !== "/api/login") {
      logout();
      throw new Error("Session expired. Please log in again.");
    }
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  },
  get(p) { return this.request("GET", p); },
  post(p, b) { return this.request("POST", p, b); },
  put(p, b) { return this.request("PUT", p, b); },
  del(p) { return this.request("DELETE", p); },
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  user: JSON.parse(localStorage.getItem("posmp_user") || "null"),
  settings: JSON.parse(localStorage.getItem("posmp_settings") || "null") || { shopName: "Shop", today: today() },
  tab: "register",
  products: [],
  cart: [], // { id, name, price, qty }
  payment: "cash",
  discount: 0,
  cashReceived: "",
  search: "",
  category: "",
  reportRange: "today",
  reportFrom: "",
  reportTo: "",
};

const app = document.getElementById("app");

const PAYMENT_LABELS = { cash: "Cash", card: "Card", qris: "QRIS", transfer: "Bank transfer", other: "Other" };
const REASON_LABELS = { receive: "Received", count: "Stock count", damage: "Damaged / lost", adjust: "Adjustment" };

const isManager = () => state.user && state.user.role === "manager";

// Rupiah, whole numbers, Indonesian grouping: Rp 75.000
function money(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? "-Rp " : "Rp ") + Math.abs(v).toLocaleString("id-ID");
}

function qtyFmt(n) { return (Number(n) || 0).toLocaleString("id-ID"); }

// Local calendar date as YYYY-MM-DD.
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function shiftDate(date, days) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateTime(iso) {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function openModal(html, { wide } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal ${wide ? "wide" : ""}">${html}</div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", close));
  return { el: backdrop, close };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function saveSession(data) {
  if (data.token) localStorage.setItem("posmp_token", data.token);
  localStorage.setItem("posmp_user", JSON.stringify(data.user));
  localStorage.setItem("posmp_settings", JSON.stringify(data.settings || {}));
  state.user = data.user;
  state.settings = data.settings || state.settings;
}

async function login(username, password) {
  saveSession(await api.post("/api/login", { username, password }));
  state.tab = "register";
}

function logout() {
  localStorage.removeItem("posmp_token");
  localStorage.removeItem("posmp_user");
  state.user = null;
  state.cart = [];
  render();
}

function changePasswordModal() {
  const m = openModal(`
    <form id="pw-form">
      <h3>Change password</h3>
      <div class="field"><label>Current password</label><input id="pw-cur" type="password" autocomplete="current-password" required /></div>
      <div class="field"><label>New password (min 8 characters)</label><input id="pw-new" type="password" autocomplete="new-password" minlength="8" required /></div>
      <div class="error-text" id="pw-error"></div>
      <div class="modal-actions">
        <button type="button" data-cancel>Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`);
  m.el.querySelector("#pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api.post("/api/me/password", {
        current: m.el.querySelector("#pw-cur").value,
        next: m.el.querySelector("#pw-new").value,
      });
      m.close();
      toast("Password changed", "ok");
    } catch (ex) {
      m.el.querySelector("#pw-error").textContent = ex.message;
    }
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function renderLogin() {
  const needsUrl = !api.base();
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <h1>${escapeHtml(state.settings.shopName || "Shop")}</h1>
        <p>Sign in to continue.</p>
        ${needsUrl ? `
        <div class="field">
          <label>API URL (Lambda Function URL)</label>
          <input id="api-url" placeholder="https://xxxx.lambda-url.ap-southeast-1.on.aws" />
        </div>` : ""}
        <div class="field">
          <label>Username</label>
          <input id="username" autocomplete="username" autocapitalize="off" />
        </div>
        <div class="field">
          <label>Password</label>
          <input id="password" type="password" autocomplete="current-password" />
        </div>
        <button class="primary" type="submit" style="width:100%">Sign in</button>
        <div class="error-text" id="login-error"></div>
      </form>
    </div>`;

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("login-error");
    err.textContent = "";
    if (needsUrl) {
      const url = document.getElementById("api-url").value.trim();
      if (!url) { err.textContent = "Enter the API URL."; return; }
      api.setBase(url);
    }
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      await login(
        document.getElementById("username").value.trim().toLowerCase(),
        document.getElementById("password").value
      );
      await loadProducts();
      render();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

function tabsForRole() {
  return isManager()
    ? [["register", "Register"], ["products", "Products"], ["inventory", "Inventory"], ["reports", "Reports"], ["users", "Users"]]
    : [["register", "Register"], ["mysales", "My sales"]];
}

function renderShell(inner) {
  const tabs = tabsForRole();
  app.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <span class="brand">${escapeHtml(state.settings.shopName || "Shop")}</span>
        <nav class="tabs">
          ${tabs.map(([id, label]) =>
            `<button class="tab ${state.tab === id ? "active" : ""}" data-tab="${id}">${label}</button>`
          ).join("")}
        </nav>
        <span class="spacer"></span>
        <button class="who" data-action="password" title="Change password">
          ${state.user ? escapeHtml(state.user.username) : ""} · ${isManager() ? "Manager" : "Operator"}
        </button>
        <button data-action="logout">Log out</button>
      </div>
      <main id="view"></main>
    </div>`;

  app.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); })
  );
  app.querySelector("[data-action=logout]").addEventListener("click", logout);
  app.querySelector("[data-action=password]").addEventListener("click", changePasswordModal);
  const view = document.getElementById("view");
  view.innerHTML = "";
  if (inner) view.appendChild(inner);
}

// Renders a view that needs to fetch data first.
function renderAsync(build) {
  renderShell(null);
  const view = document.getElementById("view");
  view.innerHTML = `<p class="muted">Loading…</p>`;
  const tab = state.tab;
  build()
    .then((el) => {
      if (state.tab !== tab) return;
      view.innerHTML = "";
      view.appendChild(el);
    })
    .catch((ex) => {
      view.innerHTML = `<p class="error-text">${escapeHtml(ex.message)}</p>`;
    });
}

// ----- Register / POS -----

function stockBadge(p) {
  if (p.stock === null || p.stock === undefined) return "";
  const low = p.lowStock ?? 5;
  const cls = p.stock <= 0 ? "out" : p.stock <= low ? "low" : "";
  return `<div class="stock ${cls}">${p.stock <= 0 ? "Out of stock" : qtyFmt(p.stock) + " in stock"}</div>`;
}

function filteredProducts() {
  const q = state.search.trim().toLowerCase();
  return state.products.filter((p) =>
    (!state.category || (p.category || "") === state.category) &&
    (!q || p.name.toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q))
  );
}

function categories() {
  return [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort();
}

function viewRegister() {
  const wrap = document.createElement("div");
  wrap.className = "register";
  const cats = categories();
  wrap.innerHTML = `
    <div>
      <div class="scan-row">
        <input id="scan" placeholder="Scan barcode or search by name / SKU, then Enter" value="${escapeAttr(state.search)}" autocomplete="off" />
      </div>
      ${cats.length ? `
      <div class="chips">
        <button class="chip ${state.category === "" ? "active" : ""}" data-cat="">All</button>
        ${cats.map((c) => `<button class="chip ${state.category === c ? "active" : ""}" data-cat="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join("")}
      </div>` : ""}
      <div class="product-grid" id="grid"></div>
    </div>
    <aside class="cart" id="cart"></aside>`;

  const scan = wrap.querySelector("#scan");
  scan.addEventListener("input", () => { state.search = scan.value; renderGrid(); });
  scan.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = scan.value.trim().toLowerCase();
    if (!q) return;
    // A barcode scanner types the SKU and presses Enter.
    const exact = state.products.find((p) => (p.sku || "").toLowerCase() === q);
    const matches = filteredProducts();
    const pick = exact || (matches.length === 1 ? matches[0] : null);
    if (pick) {
      addToCart(pick.id);
      scan.value = "";
      state.search = "";
      renderGrid();
    } else {
      toast(matches.length ? "Several products match; tap one" : "No product matches " + scan.value, "error");
    }
  });
  wrap.querySelectorAll("[data-cat]").forEach((b) =>
    b.addEventListener("click", () => { state.category = b.dataset.cat; render(); })
  );

  queueMicrotask(() => { renderGrid(); renderCart(); scan.focus(); });
  return wrap;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  if (!grid) return;
  const list = filteredProducts();
  grid.innerHTML = list.length
    ? list.map((p) => `
        <button class="product-card" data-add="${p.id}">
          <div class="name">${escapeHtml(p.name)}</div>
          <div>
            <div class="price">${money(p.price)}</div>
            ${stockBadge(p)}
          </div>
        </button>`).join("")
    : `<p class="muted">${state.products.length ? "No products match." : isManager() ? "No products yet. Add some in the Products tab." : "No products yet. Ask a manager to add some."}</p>`;
  grid.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", () => addToCart(b.dataset.add))
  );
}

function cartTotals() {
  const subtotal = state.cart.reduce((s, l) => s + l.price * l.qty, 0);
  const discount = Math.min(Math.max(0, Math.round(Number(state.discount) || 0)), subtotal);
  const total = subtotal - discount;
  const cash = state.cashReceived === "" ? null : Math.round(Number(state.cashReceived) || 0);
  return { subtotal, discount, total, cash, change: cash === null ? null : cash - total };
}

function renderCart() {
  const el = document.getElementById("cart");
  if (!el) return;
  const t = cartTotals();
  el.innerHTML = `
    <h2>Current sale</h2>
    <div class="cart-lines">
      ${state.cart.length === 0
        ? `<div class="cart-empty">Cart is empty</div>`
        : state.cart.map((l) => `
          <div class="cart-line">
            <span class="ln-name">${escapeHtml(l.name)}<small>${money(l.price)}</small></span>
            <span class="qty">
              <button data-dec="${l.id}" aria-label="Remove one">−</button>
              <span>${l.qty}</span>
              <button data-inc="${l.id}" aria-label="Add one">+</button>
            </span>
            <span class="ln-total">${money(l.price * l.qty)}</span>
          </div>`).join("")}
    </div>
    <div class="sum-line"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
    <div class="sum-line">
      <label for="discount">Discount (Rp)</label>
      <input id="discount" type="number" min="0" step="500" inputmode="numeric" value="${state.discount || ""}" placeholder="0" />
    </div>
    <div class="cart-total"><span>Total</span><span>${money(t.total)}</span></div>
    <div class="pay-row">
      <select id="payment">
        ${Object.entries(PAYMENT_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
      </select>
    </div>
    ${state.payment === "cash" ? `
    <div class="sum-line">
      <label for="cash">Cash received</label>
      <input id="cash" type="number" min="0" step="1000" inputmode="numeric" value="${state.cashReceived}" placeholder="${t.total}" />
    </div>
    <div class="quick-cash">
      ${[t.total, 50000, 100000].filter((v, i, a) => v > 0 && a.indexOf(v) === i).map((v) =>
        `<button data-cash="${v}">${v === t.total ? "Exact" : money(v)}</button>`).join("")}
    </div>
    <div class="sum-line change ${t.change !== null && t.change < 0 ? "neg" : ""}">
      <span>Change</span><span>${t.change === null ? "—" : money(t.change)}</span>
    </div>` : ""}
    <button class="success" id="checkout" style="width:100%" ${state.cart.length === 0 || (t.change !== null && t.change < 0) ? "disabled" : ""}>
      Charge ${money(t.total)}
    </button>
    ${state.cart.length ? `<button class="link" id="clear-cart">Clear sale</button>` : ""}`;

  el.querySelector("#payment").value = state.payment;
  el.querySelector("#payment").addEventListener("change", (e) => { state.payment = e.target.value; renderCart(); });
  el.querySelector("#discount").addEventListener("change", (e) => { state.discount = e.target.value; renderCart(); });
  const cash = el.querySelector("#cash");
  if (cash) cash.addEventListener("change", (e) => { state.cashReceived = e.target.value; renderCart(); });
  el.querySelectorAll("[data-cash]").forEach((b) =>
    b.addEventListener("click", () => { state.cashReceived = b.dataset.cash; renderCart(); })
  );
  el.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.inc, 1)));
  el.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.dec, -1)));
  el.querySelector("#checkout").addEventListener("click", doCheckout);
  const clear = el.querySelector("#clear-cart");
  if (clear) clear.addEventListener("click", resetCart);
}

function resetCart() {
  state.cart = [];
  state.discount = 0;
  state.cashReceived = "";
  state.payment = "cash";
  renderCart();
}

function addToCart(productId) {
  const p = state.products.find((x) => x.id === productId);
  if (!p) return;
  const line = state.cart.find((l) => l.id === productId);
  if (line) line.qty += 1;
  else state.cart.push({ id: p.id, name: p.name, price: p.price, qty: 1 });
  renderCart();
}

function changeQty(productId, delta) {
  const line = state.cart.find((l) => l.id === productId);
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) state.cart = state.cart.filter((l) => l.id !== productId);
  renderCart();
}

async function doCheckout() {
  if (state.cart.length === 0) return;
  const btn = document.getElementById("checkout");
  btn.disabled = true;
  const t = cartTotals();
  try {
    const { sale } = await api.post("/api/sales", {
      items: state.cart.map((l) => ({ productId: l.id, qty: l.qty })),
      discount: t.discount,
      payment: state.payment,
      cashReceived: state.payment === "cash" && t.cash !== null ? t.cash : undefined,
    });
    state.cart = [];
    state.discount = 0;
    state.cashReceived = "";
    state.payment = "cash";
    await loadProducts(); // refresh stock counts
    render();
    receiptModal(sale);
  } catch (ex) {
    toast(ex.message, "error");
    btn.disabled = false;
  }
}

function receiptHtml(sale) {
  return `
    <div class="receipt" id="receipt">
      <div class="r-head">
        <strong>${escapeHtml(state.settings.shopName || "Shop")}</strong>
        <div>${new Date(sale.createdAt).toLocaleString("en-GB")}</div>
        <div>Served by ${escapeHtml(sale.cashier)} · #${escapeHtml(sale.id.slice(-6).toUpperCase())}</div>
      </div>
      <table>
        ${sale.items.map((l) => `
          <tr><td colspan="2">${escapeHtml(l.name)}</td></tr>
          <tr><td class="muted">${l.qty} × ${money(l.price)}</td><td class="right">${money(l.price * l.qty)}</td></tr>`).join("")}
      </table>
      <div class="r-sum"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
      ${sale.discount ? `<div class="r-sum"><span>Discount</span><span>-${money(sale.discount)}</span></div>` : ""}
      <div class="r-sum r-total"><span>Total</span><span>${money(sale.total)}</span></div>
      <div class="r-sum"><span>${PAYMENT_LABELS[sale.payment] || sale.payment}</span><span>${money(sale.cashReceived ?? sale.total)}</span></div>
      ${sale.change ? `<div class="r-sum"><span>Change</span><span>${money(sale.change)}</span></div>` : ""}
      ${sale.refundTotal ? `<div class="r-sum"><span>Refunded</span><span>-${money(sale.refundTotal)}</span></div>` : ""}
      <div class="r-foot">Thank you!</div>
    </div>`;
}

function receiptModal(sale) {
  const m = openModal(`
    <h3>Sale recorded</h3>
    ${receiptHtml(sale)}
    <div class="modal-actions">
      <button type="button" id="print-receipt">Print receipt</button>
      <button class="primary" type="button" data-cancel>New sale</button>
    </div>`);
  m.el.querySelector("#print-receipt").addEventListener("click", () => window.print());
}

// ----- My sales (operator) -----

async function viewMySales() {
  const wrap = document.createElement("div");
  const { sales } = await api.get("/api/sales");
  const total = sales.reduce((s, x) => s + x.total, 0);
  wrap.innerHTML = `
    <div class="section-head"><h2>My sales today</h2></div>
    <div class="stat-row">
      <div class="stat"><div class="label">Sales total</div><div class="value">${money(total)}</div></div>
      <div class="stat"><div class="label">Transactions</div><div class="value">${sales.length}</div></div>
    </div>
    ${salesTable(sales, { refunds: false })}`;
  bindSalesTable(wrap, sales);
  return wrap;
}

function salesTable(sales, { refunds }) {
  return `
    <div class="card scroll">
      <table>
        <thead><tr><th>Time</th><th>Items</th><th>Payment</th><th>Operator</th><th class="right">Total</th><th></th></tr></thead>
        <tbody>
          ${sales.length === 0
            ? `<tr><td colspan="6" class="muted empty">No sales yet.</td></tr>`
            : sales.map((s, i) => `
              <tr>
                <td>${dateTime(s.createdAt)}</td>
                <td>${s.items.reduce((n, l) => n + l.qty, 0)} item(s)</td>
                <td>${PAYMENT_LABELS[s.payment] || escapeHtml(s.payment)}</td>
                <td class="muted">${escapeHtml(s.cashier || "—")}</td>
                <td class="right">${money(s.total)}${s.refundTotal ? `<div class="small neg">-${money(s.refundTotal)} refunded</div>` : ""}</td>
                <td class="right nowrap">
                  <button data-receipt="${i}">Receipt</button>
                  ${refunds ? `<button data-refund="${i}">Refund</button>` : ""}
                </td>
              </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function bindSalesTable(wrap, sales) {
  wrap.querySelectorAll("[data-receipt]").forEach((b) =>
    b.addEventListener("click", () => {
      const m = openModal(`${receiptHtml(sales[b.dataset.receipt])}
        <div class="modal-actions">
          <button type="button" id="print-receipt">Print</button>
          <button class="primary" type="button" data-cancel>Close</button>
        </div>`);
      m.el.querySelector("#print-receipt").addEventListener("click", () => window.print());
    })
  );
  wrap.querySelectorAll("[data-refund]").forEach((b) =>
    b.addEventListener("click", () => refundModal(sales[b.dataset.refund]))
  );
}

// ----- Products (manager) -----

function viewProducts() {
  const wrap = document.createElement("div");
  const q = state.search.trim().toLowerCase();
  const list = state.products.filter((p) =>
    !q || p.name.toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q)
  );
  wrap.innerHTML = `
    <div class="section-head">
      <h2>Products</h2>
      <button id="export-products">Export CSV</button>
      <button id="import-products">Import CSV</button>
      <button class="primary" id="add-product">+ Add product</button>
    </div>
    <div class="scan-row"><input id="product-search" placeholder="Filter by name, SKU or category" value="${escapeAttr(state.search)}" /></div>
    <div class="card scroll">
      <table>
        <thead>
          <tr><th>Name</th><th>SKU</th><th>Category</th><th class="right">Cost</th><th class="right">Price</th><th class="right">Margin</th><th class="right">Stock</th><th></th></tr>
        </thead>
        <tbody>
          ${list.length === 0
            ? `<tr><td colspan="8" class="muted empty">No products${q ? " match" : " yet"}.</td></tr>`
            : list.map((p) => {
                const margin = p.price > 0 ? Math.round(((p.price - (p.cost || 0)) / p.price) * 100) : 0;
                return `
              <tr>
                <td>${escapeHtml(p.name)}</td>
                <td class="muted">${escapeHtml(p.sku || "—")}</td>
                <td class="muted">${escapeHtml(p.category || "—")}</td>
                <td class="right">${money(p.cost)}</td>
                <td class="right">${money(p.price)}</td>
                <td class="right ${margin < 0 ? "neg" : ""}">${p.cost ? margin + "%" : "—"}</td>
                <td class="right">${p.stock === null || p.stock === undefined ? `<span class="muted">not tracked</span>` : stockCell(p)}</td>
                <td class="right nowrap">
                  <button data-edit="${p.id}">Edit</button>
                  <button class="danger" data-del="${p.id}">Delete</button>
                </td>
              </tr>`;
              }).join("")}
        </tbody>
      </table>
    </div>`;

  const search = wrap.querySelector("#product-search");
  search.addEventListener("input", () => {
    state.search = search.value;
    const pos = search.selectionStart;
    render();
    const again = document.getElementById("product-search");
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  wrap.querySelector("#add-product").addEventListener("click", () => productModal());
  wrap.querySelector("#import-products").addEventListener("click", importModal);
  wrap.querySelector("#export-products").addEventListener("click", () =>
    downloadCsv("products-" + today() + ".csv", [
      ["name", "sku", "category", "price", "cost", "stock", "lowStock"],
      ...state.products.map((p) => [p.name, p.sku || "", p.category || "", p.price, p.cost || 0, p.stock ?? "", p.lowStock ?? 5]),
    ])
  );
  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => productModal(state.products.find((p) => p.id === b.dataset.edit)))
  );
  wrap.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteProduct(b.dataset.del))
  );
  return wrap;
}

function stockCell(p) {
  const low = p.lowStock ?? 5;
  const cls = p.stock <= 0 ? "neg" : p.stock <= low ? "warn" : "";
  return `<span class="${cls}">${qtyFmt(p.stock)}</span>`;
}

function productModal(existing) {
  const p = existing || {};
  const tracked = existing ? p.stock !== null && p.stock !== undefined : true;
  const m = openModal(`
    <form id="product-form">
      <h3>${existing ? "Edit product" : "Add product"}</h3>
      <div class="field"><label>Name</label><input id="p-name" value="${escapeAttr(p.name || "")}" required /></div>
      <div class="grid2">
        <div class="field"><label>SKU / barcode</label><input id="p-sku" value="${escapeAttr(p.sku || "")}" /></div>
        <div class="field"><label>Category</label><input id="p-category" list="category-list" value="${escapeAttr(p.category || "")}" />
          <datalist id="category-list">${categories().map((c) => `<option value="${escapeAttr(c)}">`).join("")}</datalist></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Cost of goods (Rp)</label><input id="p-cost" type="number" min="0" step="1" inputmode="numeric" value="${p.cost ?? ""}" /></div>
        <div class="field"><label>Selling price (Rp)</label><input id="p-price" type="number" min="0" step="1" inputmode="numeric" value="${p.price ?? ""}" required /></div>
      </div>
      <label class="check"><input id="p-track" type="checkbox" ${tracked ? "checked" : ""} /> Track stock for this product</label>
      <div class="grid2" id="stock-fields">
        ${existing ? "" : `<div class="field"><label>Opening stock</label><input id="p-stock" type="number" min="0" step="1" value="0" /></div>`}
        <div class="field"><label>Low-stock alert at</label><input id="p-low" type="number" min="0" step="1" value="${p.lowStock ?? 5}" /></div>
      </div>
      ${existing && tracked ? `<p class="muted small">To change the stock count, use Inventory → Adjust stock so the change is recorded.</p>` : ""}
      <div class="error-text" id="p-error"></div>
      <div class="modal-actions">
        <button type="button" data-cancel>Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`);

  const track = m.el.querySelector("#p-track");
  const syncTrack = () => { m.el.querySelector("#stock-fields").style.display = track.checked ? "" : "none"; };
  track.addEventListener("change", syncTrack);
  syncTrack();

  m.el.querySelector("#product-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = (id) => m.el.querySelector(id) && m.el.querySelector(id).value.trim();
    const payload = {
      name: val("#p-name"),
      sku: val("#p-sku"),
      category: val("#p-category"),
      cost: Number(val("#p-cost")) || 0,
      price: Number(val("#p-price")) || 0,
      trackStock: track.checked,
      lowStock: val("#p-low"),
    };
    if (!existing) payload.stock = Number(val("#p-stock")) || 0;
    try {
      if (existing) await api.put("/api/products/" + encodeURIComponent(existing.id), payload);
      else await api.post("/api/products", payload);
      m.close();
      await loadProducts();
      render();
      toast("Saved", "ok");
    } catch (ex) {
      m.el.querySelector("#p-error").textContent = ex.message;
    }
  });
}

function importModal() {
  const m = openModal(`
    <h3>Import products from CSV</h3>
    <p class="muted small">Columns: <code>name, sku, category, price, cost, stock, lowStock</code>. The first row must be the header.
      Rows with a SKU that already exists update that product (blank cells keep the current value; stock is only used for new products).</p>
    <div class="field"><input id="csv-file" type="file" accept=".csv,text/csv" /></div>
    <div id="csv-preview" class="muted small"></div>
    <div class="error-text" id="csv-error"></div>
    <div class="modal-actions">
      <button type="button" id="csv-template">Download template</button>
      <button type="button" data-cancel>Cancel</button>
      <button class="primary" type="button" id="csv-go" disabled>Import</button>
    </div>`);
  let rows = [];
  m.el.querySelector("#csv-template").addEventListener("click", () =>
    downloadCsv("products-template.csv", [
      ["name", "sku", "category", "price", "cost", "stock", "lowStock"],
      ["Beras 5kg", "8991234567890", "Groceries", "75000", "62000", "20", "5"],
    ])
  );
  m.el.querySelector("#csv-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const table = parseCsv(await file.text());
    const header = (table.shift() || []).map((h) => h.trim().toLowerCase());
    const keys = { name: "name", sku: "sku", category: "category", price: "price", cost: "cost", stock: "stock", lowstock: "lowStock" };
    rows = table
      .filter((r) => r.some((c) => c.trim() !== ""))
      .map((r) => {
        const o = {};
        header.forEach((h, i) => { if (keys[h]) o[keys[h]] = (r[i] || "").trim(); });
        return o;
      });
    m.el.querySelector("#csv-preview").textContent = header.includes("name")
      ? `${rows.length} row(s) ready to import.`
      : "";
    m.el.querySelector("#csv-error").textContent = header.includes("name") ? "" : "The header row needs at least a 'name' column.";
    m.el.querySelector("#csv-go").disabled = !header.includes("name") || rows.length === 0;
  });
  m.el.querySelector("#csv-go").addEventListener("click", async () => {
    try {
      const r = await api.post("/api/products/import", { products: rows });
      await loadProducts();
      render();
      if (r.errors.length) {
        m.el.querySelector("#csv-error").textContent =
          `${r.created} created, ${r.updated} updated. Skipped: ` + r.errors.map((x) => `row ${x.row + 1} (${x.error})`).join("; ");
        m.el.querySelector("#csv-go").disabled = true;
      } else {
        m.close();
        toast(`${r.created} created, ${r.updated} updated`, "ok");
      }
    } catch (ex) {
      m.el.querySelector("#csv-error").textContent = ex.message;
    }
  });
}

async function deleteProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!confirm(`Delete ${p ? p.name : "this product"}? Past sales keep their records.`)) return;
  try {
    await api.del("/api/products/" + encodeURIComponent(id));
    await loadProducts();
    render();
    toast("Deleted", "ok");
  } catch (ex) {
    toast(ex.message, "error");
  }
}

// ----- Inventory (manager) -----

async function viewInventory() {
  const wrap = document.createElement("div");
  const [stock, moves] = await Promise.all([api.get("/api/reports/stock"), api.get("/api/stock/movements")]);
  wrap.innerHTML = `
    <div class="section-head">
      <h2>Inventory</h2>
      <button class="primary" id="adjust">Adjust stock</button>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="label">Stock value at cost</div><div class="value">${money(stock.costValue)}</div></div>
      <div class="stat"><div class="label">Stock value at price</div><div class="value">${money(stock.retailValue)}</div></div>
      <div class="stat"><div class="label">Units on hand</div><div class="value">${qtyFmt(stock.units)}</div></div>
      <div class="stat"><div class="label">Low / out of stock</div><div class="value ${stock.lowStock.length ? "warn" : ""}">${stock.lowStock.length} / ${stock.outOfStock}</div></div>
    </div>
    <div class="section-head"><h3>Low stock</h3></div>
    <div class="card scroll">
      <table>
        <thead><tr><th>Product</th><th>SKU</th><th class="right">On hand</th><th class="right">Alert at</th><th></th></tr></thead>
        <tbody>
          ${stock.lowStock.length === 0
            ? `<tr><td colspan="5" class="muted empty">Nothing is running low.</td></tr>`
            : stock.lowStock.map((p) => `
              <tr>
                <td>${escapeHtml(p.name)}</td>
                <td class="muted">${escapeHtml(p.sku || "—")}</td>
                <td class="right ${p.stock <= 0 ? "neg" : "warn"}">${qtyFmt(p.stock)}</td>
                <td class="right muted">${p.lowStock}</td>
                <td class="right"><button data-receive="${p.id}">Receive</button></td>
              </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="section-head"><h3>Stock movements (last 30 days)</h3></div>
    <div class="card scroll">
      <table>
        <thead><tr><th>Time</th><th>Product</th><th>Type</th><th class="right">Change</th><th class="right">After</th><th class="right">Unit cost</th><th>Note</th><th>By</th></tr></thead>
        <tbody>
          ${moves.movements.length === 0
            ? `<tr><td colspan="8" class="muted empty">No stock adjustments yet.</td></tr>`
            : moves.movements.map((mv) => `
              <tr>
                <td>${dateTime(mv.createdAt)}</td>
                <td>${escapeHtml(mv.productName)}</td>
                <td>${REASON_LABELS[mv.reason] || escapeHtml(mv.reason)}</td>
                <td class="right ${mv.qty < 0 ? "neg" : "pos"}">${mv.qty > 0 ? "+" : ""}${qtyFmt(mv.qty)}</td>
                <td class="right">${qtyFmt(mv.stockAfter)}</td>
                <td class="right">${mv.unitCost !== undefined ? money(mv.unitCost) : "—"}</td>
                <td class="muted">${escapeHtml(mv.note || "")}</td>
                <td class="muted">${escapeHtml(mv.by)}</td>
              </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  wrap.querySelector("#adjust").addEventListener("click", () => adjustModal());
  wrap.querySelectorAll("[data-receive]").forEach((b) =>
    b.addEventListener("click", () => adjustModal(b.dataset.receive))
  );
  return wrap;
}

function adjustModal(productId) {
  if (state.products.length === 0) { toast("Add a product first", "error"); return; }
  const m = openModal(`
    <form id="adjust-form">
      <h3>Adjust stock</h3>
      <div class="field"><label>Product</label>
        <select id="a-product">
          ${state.products.map((p) => `<option value="${p.id}" ${p.id === productId ? "selected" : ""}>${escapeHtml(p.name)}${p.sku ? " · " + escapeHtml(p.sku) : ""}</option>`).join("")}
        </select>
        <div class="muted small" id="a-current"></div>
      </div>
      <div class="field"><label>Type</label>
        <select id="a-reason">
          ${Object.entries(REASON_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
        </select>
      </div>
      <div class="grid2">
        <div class="field"><label id="a-qty-label">Quantity received</label><input id="a-qty" type="number" step="1" required /></div>
        <div class="field" id="a-cost-wrap"><label>Unit cost (Rp, optional)</label><input id="a-cost" type="number" min="0" step="1" /></div>
      </div>
      <div class="field"><label>Note (optional)</label><input id="a-note" maxlength="200" placeholder="e.g. supplier invoice number" /></div>
      <div class="error-text" id="a-error"></div>
      <div class="modal-actions">
        <button type="button" data-cancel>Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`);

  const $ = (id) => m.el.querySelector(id);
  const sync = () => {
    const p = state.products.find((x) => x.id === $("#a-product").value);
    const reason = $("#a-reason").value;
    $("#a-current").textContent = p
      ? (p.stock === null || p.stock === undefined ? "Not tracked yet; this starts tracking." : `On hand: ${qtyFmt(p.stock)} · Current cost ${money(p.cost)}`)
      : "";
    $("#a-qty-label").textContent = {
      receive: "Quantity received",
      count: "Counted quantity on shelf",
      damage: "Quantity damaged or lost",
      adjust: "Change (+ or −)",
    }[reason];
    $("#a-qty").min = reason === "adjust" ? "" : "0";
    $("#a-cost-wrap").style.display = reason === "receive" ? "" : "none";
  };
  $("#a-product").addEventListener("change", sync);
  $("#a-reason").addEventListener("change", sync);
  sync();

  $("#adjust-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = $("#a-reason").value;
    const n = parseInt($("#a-qty").value, 10);
    const body = { productId: $("#a-product").value, reason, note: $("#a-note").value.trim() || undefined };
    if (reason === "count") body.countedQty = n;
    else body.qty = n;
    if (reason === "receive" && $("#a-cost").value !== "") body.unitCost = Number($("#a-cost").value);
    try {
      const r = await api.post("/api/stock/adjust", body);
      m.close();
      await loadProducts();
      render();
      toast(`Saved. On hand now ${qtyFmt(r.stock)}`, "ok");
    } catch (ex) {
      $("#a-error").textContent = ex.message;
    }
  });
}

// ----- Reports (manager) -----

function reportRange() {
  const t = today();
  switch (state.reportRange) {
    case "yesterday": return { from: shiftDate(t, -1), to: shiftDate(t, -1) };
    case "7d": return { from: shiftDate(t, -6), to: t };
    case "month": return { from: t.slice(0, 8) + "01", to: t };
    case "custom": return { from: state.reportFrom || t, to: state.reportTo || t };
    default: return { from: t, to: t };
  }
}

async function viewReports() {
  const wrap = document.createElement("div");
  const { from, to } = reportRange();
  const qs = `?from=${from}&to=${to}`;
  const [r, list] = await Promise.all([api.get("/api/reports/summary" + qs), api.get("/api/sales" + qs)]);
  const ranges = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["month", "This month"], ["custom", "Custom"]];
  const maxDay = Math.max(1, ...r.byDay.map((d) => d.netSales));

  wrap.innerHTML = `
    <div class="section-head">
      <h2>Reports</h2>
      <button id="export-sales">Export sales CSV</button>
    </div>
    <div class="chips">
      ${ranges.map(([v, l]) => `<button class="chip ${state.reportRange === v ? "active" : ""}" data-range="${v}">${l}</button>`).join("")}
      ${state.reportRange === "custom" ? `
        <input type="date" id="r-from" value="${from}" /> <span class="muted">to</span> <input type="date" id="r-to" value="${to}" />` : ""}
    </div>
    <p class="muted small">${from === to ? from : from + " to " + to}</p>
    <div class="stat-row">
      <div class="stat"><div class="label">Net sales</div><div class="value">${money(r.netSales)}</div></div>
      <div class="stat"><div class="label">Gross profit</div><div class="value">${money(r.grossProfit)}</div><div class="sub">${r.margin}% margin</div></div>
      <div class="stat"><div class="label">Transactions</div><div class="value">${r.count}</div><div class="sub">avg ${money(r.averageSale)}</div></div>
      <div class="stat"><div class="label">Cost of goods sold</div><div class="value">${money(r.cogs)}</div></div>
    </div>
    <div class="stat-row small-stats">
      <div class="stat"><div class="label">Gross sales</div><div class="value">${money(r.grossSales)}</div></div>
      <div class="stat"><div class="label">Discounts</div><div class="value">${money(r.discounts)}</div></div>
      <div class="stat"><div class="label">Refunds</div><div class="value">${money(r.refunds)}</div></div>
      ${Object.entries(r.byPayment).map(([k, v]) =>
        `<div class="stat"><div class="label">${PAYMENT_LABELS[k] || escapeHtml(k)}</div><div class="value">${money(v)}</div></div>`).join("")}
    </div>

    ${r.byDay.length > 1 ? `
    <div class="section-head"><h3>By day</h3></div>
    <div class="card scroll">
      <table>
        <thead><tr><th>Date</th><th></th><th class="right">Transactions</th><th class="right">Net sales</th><th class="right">Gross profit</th></tr></thead>
        <tbody>
          ${r.byDay.map((d) => `
            <tr>
              <td class="nowrap">${d.date}</td>
              <td class="bar-cell"><div class="bar" style="width:${Math.max(0, (d.netSales / maxDay) * 100)}%"></div></td>
              <td class="right">${d.count}</td>
              <td class="right">${money(d.netSales)}</td>
              <td class="right">${money(d.grossProfit)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}

    <div class="two-col">
      <div>
        <div class="section-head"><h3>Best sellers</h3></div>
        <div class="card scroll">
          <table>
            <thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Revenue</th><th class="right">Profit</th></tr></thead>
            <tbody>
              ${r.bestSellers.length === 0
                ? `<tr><td colspan="4" class="muted empty">No sales in this period.</td></tr>`
                : r.bestSellers.map((p) => `
                  <tr><td>${escapeHtml(p.name)}</td><td class="right">${qtyFmt(p.qty)}</td><td class="right">${money(p.revenue)}</td><td class="right">${money(p.profit)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div class="section-head"><h3>By category</h3></div>
        <div class="card scroll">
          <table>
            <thead><tr><th>Category</th><th class="right">Qty</th><th class="right">Revenue</th></tr></thead>
            <tbody>
              ${r.byCategory.length === 0
                ? `<tr><td colspan="3" class="muted empty">No sales in this period.</td></tr>`
                : r.byCategory.map((c) => `
                  <tr><td>${escapeHtml(c.category)}</td><td class="right">${qtyFmt(c.qty)}</td><td class="right">${money(c.revenue)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="section-head"><h3>Sales</h3></div>
    ${salesTable(list.sales, { refunds: true })}`;

  wrap.querySelectorAll("[data-range]").forEach((b) =>
    b.addEventListener("click", () => {
      state.reportRange = b.dataset.range;
      if (b.dataset.range === "custom" && !state.reportFrom) {
        state.reportFrom = from;
        state.reportTo = to;
      }
      render();
    })
  );
  ["#r-from", "#r-to"].forEach((id) => {
    const input = wrap.querySelector(id);
    if (input) input.addEventListener("change", () => {
      state.reportFrom = wrap.querySelector("#r-from").value;
      state.reportTo = wrap.querySelector("#r-to").value;
      render();
    });
  });
  wrap.querySelector("#export-sales").addEventListener("click", () => exportSales(list, from, to));
  bindSalesTable(wrap, list.sales);
  return wrap;
}

// One row per sale line, plus one row per refunded line, so a spreadsheet can
// total any column directly.
function exportSales(list, from, to) {
  const rows = [["type", "time", "sale_id", "operator", "payment", "product", "sku", "category", "qty", "unit_price", "unit_cost", "line_total", "sale_discount", "sale_total"]];
  for (const s of [...list.sales].reverse()) {
    for (const l of s.items) {
      rows.push(["sale", s.createdAt, s.id, s.cashier, s.payment, l.name, l.sku || "", l.category || "", l.qty, l.price, l.cost ?? "", l.price * l.qty, s.discount || 0, s.total]);
    }
  }
  for (const f of list.refunds || []) {
    for (const l of f.items) {
      rows.push(["refund", f.createdAt, f.saleId, f.by, f.payment, l.name, "", l.category || "", -l.qty, l.price, l.cost ?? "", -l.price * l.qty, "", -f.amount]);
    }
  }
  downloadCsv(`sales-${from}${from === to ? "" : "-to-" + to}.csv`, rows);
}

function refundModal(sale) {
  const left = (l) => l.qty - ((sale.refundedQty || {})[l.productId] || 0);
  const m = openModal(`
    <form id="refund-form">
      <h3>Refund items</h3>
      <p class="muted small">Sale of ${dateTime(sale.createdAt)} by ${escapeHtml(sale.cashier)}, total ${money(sale.total)}${sale.discount ? ` (after ${money(sale.discount)} discount; refunds are reduced by the same share)` : ""}.</p>
      <table>
        <thead><tr><th>Item</th><th class="right">Sold</th><th class="right">Refund qty</th></tr></thead>
        <tbody>
          ${sale.items.map((l, i) => `
            <tr>
              <td>${escapeHtml(l.name)}<div class="muted small">${money(l.price)}</div></td>
              <td class="right">${l.qty}${left(l) < l.qty ? `<div class="muted small">${l.qty - left(l)} refunded</div>` : ""}</td>
              <td class="right"><input class="qty-input" data-line="${i}" type="number" min="0" max="${left(l)}" step="1" value="0" ${left(l) === 0 ? "disabled" : ""} /></td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="field" style="margin-top:12px"><label>Reason (optional)</label><input id="rf-reason" maxlength="200" /></div>
      <label class="check"><input id="rf-restock" type="checkbox" checked /> Put the items back into stock</label>
      <div class="error-text" id="rf-error"></div>
      <div class="modal-actions">
        <button type="button" data-cancel>Cancel</button>
        <button class="primary" type="submit">Refund</button>
      </div>
    </form>`, { wide: true });

  m.el.querySelector("#refund-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const items = [...m.el.querySelectorAll("[data-line]")]
      .map((inp) => ({ productId: sale.items[inp.dataset.line].productId, qty: parseInt(inp.value, 10) || 0 }))
      .filter((x) => x.qty > 0);
    try {
      const { refund } = await api.post("/api/refunds", {
        saleId: sale.id,
        createdAt: sale.createdAt,
        items,
        reason: m.el.querySelector("#rf-reason").value.trim() || undefined,
        restock: m.el.querySelector("#rf-restock").checked,
      });
      m.close();
      await loadProducts();
      render();
      toast(`Refunded ${money(refund.amount)}`, "ok");
    } catch (ex) {
      m.el.querySelector("#rf-error").textContent = ex.message;
    }
  });
}

// ----- Users (manager) -----

async function viewUsers() {
  const wrap = document.createElement("div");
  const { users } = await api.get("/api/users");
  users.sort((a, b) => a.role.localeCompare(b.role) || a.username.localeCompare(b.username));
  wrap.innerHTML = `
    <div class="section-head">
      <h2>Users</h2>
      <button class="primary" id="add-user">+ Add user</button>
    </div>
    <p class="muted small"><strong>Managers</strong> manage products, cost of goods, stock, refunds, reports and users.
      <strong>Operators</strong> record sales at the register and see their own sales for today.</p>
    <div class="card scroll">
      <table>
        <thead><tr><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td>${escapeHtml(u.username)}${u.username === state.user.username ? ` <span class="muted">(you)</span>` : ""}</td>
              <td>${u.role === "manager" ? "Manager" : "Operator"}</td>
              <td>${u.active ? "Active" : `<span class="muted">Deactivated</span>`}</td>
              <td class="right nowrap">
                <button data-user="${escapeAttr(u.username)}">Edit</button>
                ${u.username === state.user.username ? "" : `<button class="danger" data-deluser="${escapeAttr(u.username)}">Delete</button>`}
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  wrap.querySelector("#add-user").addEventListener("click", () => userModal());
  wrap.querySelectorAll("[data-user]").forEach((b) =>
    b.addEventListener("click", () => userModal(users.find((u) => u.username === b.dataset.user)))
  );
  wrap.querySelectorAll("[data-deluser]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`Delete user ${b.dataset.deluser}? Their past sales stay on record.`)) return;
      try {
        await api.del("/api/users/" + encodeURIComponent(b.dataset.deluser));
        render();
        toast("User deleted", "ok");
      } catch (ex) {
        toast(ex.message, "error");
      }
    })
  );
  return wrap;
}

function userModal(existing) {
  const u = existing || { role: "operator", active: true };
  const self = existing && existing.username === state.user.username;
  const m = openModal(`
    <form id="user-form">
      <h3>${existing ? "Edit " + escapeHtml(u.username) : "Add user"}</h3>
      ${existing ? "" : `<div class="field"><label>Username</label><input id="u-name" autocapitalize="off" required pattern="[A-Za-z0-9._\\-]{3,32}" /></div>`}
      <div class="field"><label>Role</label>
        <select id="u-role" ${self ? "disabled" : ""}>
          <option value="operator">Operator: records sales</option>
          <option value="manager">Manager: full access</option>
        </select>
      </div>
      <div class="field"><label>${existing ? "New password (leave blank to keep)" : "Password (min 8 characters)"}</label>
        <input id="u-pass" type="password" autocomplete="new-password" ${existing ? "" : "required minlength=8"} /></div>
      ${existing && !self ? `<label class="check"><input id="u-active" type="checkbox" ${u.active ? "checked" : ""} /> Active (can sign in)</label>` : ""}
      <div class="error-text" id="u-error"></div>
      <div class="modal-actions">
        <button type="button" data-cancel>Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`);
  m.el.querySelector("#u-role").value = u.role;

  m.el.querySelector("#user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = m.el.querySelector("#u-pass").value;
    try {
      if (existing) {
        const body = {};
        if (!self) body.role = m.el.querySelector("#u-role").value;
        if (pass) body.password = pass;
        const active = m.el.querySelector("#u-active");
        if (active) body.active = active.checked;
        await api.put("/api/users/" + encodeURIComponent(u.username), body);
      } else {
        await api.post("/api/users", {
          username: m.el.querySelector("#u-name").value.trim().toLowerCase(),
          password: pass,
          role: m.el.querySelector("#u-role").value,
        });
      }
      m.close();
      render();
      toast("Saved", "ok");
    } catch (ex) {
      m.el.querySelector("#u-error").textContent = ex.message;
    }
  });
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  text = text.replace(/^﻿/, "");
  // Excel in many locales (including Indonesia) saves CSV with semicolons.
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Data loading + render dispatch
// ---------------------------------------------------------------------------

async function loadProducts() {
  const data = await api.get("/api/products");
  state.products = (data.products || []).sort((a, b) => a.name.localeCompare(b.name));
}

let lastTab = null;

function render() {
  if (!state.user || !api.token()) {
    renderLogin();
    return;
  }
  if (!tabsForRole().some(([id]) => id === state.tab)) state.tab = "register";
  // The search box is shared by Register and Products; clear it when switching.
  if (state.tab !== lastTab) {
    if (lastTab !== null) state.search = "";
    lastTab = state.tab;
  }
  switch (state.tab) {
    case "products": renderShell(viewProducts()); break;
    case "inventory": renderAsync(viewInventory); break;
    case "reports": renderAsync(viewReports); break;
    case "users": renderAsync(viewUsers); break;
    case "mysales": renderAsync(viewMySales); break;
    default: renderShell(viewRegister());
  }
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  if (state.user && api.token()) {
    try {
      // Pick up role changes and the shop's settings since the last visit.
      saveSession(await api.get("/api/me"));
      await loadProducts();
    } catch (_) {}
  }
  render();
})();
