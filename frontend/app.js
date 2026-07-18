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
  tab: "register",
  products: [],
  cart: [], // { id, name, price, qty, tracksStock }
  payment: "cash",
};

const app = document.getElementById("app");
const money = (n) => "$" + (Number(n) || 0).toFixed(2);

function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function login(username, password) {
  const data = await api.post("/api/login", { username, password });
  localStorage.setItem("posmp_token", data.token);
  localStorage.setItem("posmp_user", JSON.stringify(data.user));
  state.user = data.user;
}

function logout() {
  localStorage.removeItem("posmp_token");
  localStorage.removeItem("posmp_user");
  state.user = null;
  state.cart = [];
  render();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function renderLogin() {
  const needsUrl = !api.base();
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <h1>Shop Register</h1>
        <p>Sign in to open the till.</p>
        ${needsUrl ? `
        <div class="field">
          <label>API URL (Lambda Function URL)</label>
          <input id="api-url" placeholder="https://xxxx.lambda-url.region.on.aws" />
        </div>` : ""}
        <div class="field">
          <label>Username</label>
          <input id="username" autocomplete="username" value="admin" />
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
        document.getElementById("username").value.trim(),
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

function renderShell(inner) {
  const tabs = [
    ["register", "Register"],
    ["products", "Products"],
    ["reports", "Reports"],
  ];
  app.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <span class="brand">🛒 POS</span>
        ${tabs.map(([id, label]) =>
          `<button class="tab ${state.tab === id ? "active" : ""}" data-tab="${id}">${label}</button>`
        ).join("")}
        <span class="spacer"></span>
        <span class="who">${state.user ? state.user.username : ""}</span>
        <button data-action="logout">Log out</button>
      </div>
      <main id="view"></main>
    </div>`;

  app.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); })
  );
  app.querySelector("[data-action=logout]").addEventListener("click", logout);
  document.getElementById("view").innerHTML = "";
  document.getElementById("view").appendChild(inner);
}

// ----- Register / POS -----

function viewRegister() {
  const wrap = document.createElement("div");
  wrap.className = "register";

  const gridItems = state.products.length
    ? state.products.map((p) => {
        const out = p.stock !== null && p.stock !== undefined && p.stock <= 0;
        const low = p.stock !== null && p.stock !== undefined && p.stock > 0 && p.stock <= 5;
        const stockLine =
          p.stock === null || p.stock === undefined
            ? ""
            : `<div class="stock ${out ? "out" : low ? "low" : ""}">${out ? "Out of stock" : p.stock + " in stock"}</div>`;
        return `
          <button class="product-card" data-add="${p.id}" ${out ? "disabled" : ""}>
            <div class="name">${escapeHtml(p.name)}</div>
            <div>
              <div class="price">${money(p.price)}</div>
              ${stockLine}
            </div>
          </button>`;
      }).join("")
    : `<p class="muted">No products yet. Add some in the Products tab.</p>`;

  wrap.innerHTML = `
    <div>
      <div class="section-head"><h2>Tap to add</h2></div>
      <div class="product-grid">${gridItems}</div>
    </div>
    <aside class="cart" id="cart"></aside>`;

  wrap.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", () => addToCart(b.dataset.add))
  );
  // Cart is rendered separately so we can refresh it without rebuilding the grid.
  queueMicrotask(() => renderCart());
  return wrap;
}

function renderCart() {
  const el = document.getElementById("cart");
  if (!el) return;
  const total = state.cart.reduce((s, l) => s + l.price * l.qty, 0);
  el.innerHTML = `
    <h2>Current sale</h2>
    <div class="cart-lines">
      ${state.cart.length === 0
        ? `<div class="cart-empty">Cart is empty</div>`
        : state.cart.map((l) => `
          <div class="cart-line" data-line="${l.id}">
            <span class="ln-name">${escapeHtml(l.name)}</span>
            <span class="qty">
              <button data-dec="${l.id}">−</button>
              <span>${l.qty}</span>
              <button data-inc="${l.id}">+</button>
            </span>
            <span class="ln-total">${money(l.price * l.qty)}</span>
          </div>`).join("")}
    </div>
    <div class="cart-total"><span>Total</span><span>${money(total)}</span></div>
    <div class="pay-row">
      <select id="payment">
        <option value="cash">Cash</option>
        <option value="card">Card</option>
        <option value="other">Other</option>
      </select>
    </div>
    <button class="success" id="checkout" style="width:100%" ${state.cart.length === 0 ? "disabled" : ""}>
      Charge ${money(total)}
    </button>`;

  el.querySelector("#payment").value = state.payment;
  el.querySelector("#payment").addEventListener("change", (e) => { state.payment = e.target.value; });
  el.querySelectorAll("[data-inc]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.inc, 1)));
  el.querySelectorAll("[data-dec]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.dec, -1)));
  const checkout = el.querySelector("#checkout");
  if (checkout) checkout.addEventListener("click", doCheckout);
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
  try {
    await api.post("/api/sales", {
      items: state.cart.map((l) => ({ productId: l.id, name: l.name, price: l.price, qty: l.qty })),
      payment: state.payment,
    });
    toast("Sale recorded", "ok");
    state.cart = [];
    await loadProducts(); // refresh stock counts
    render();
  } catch (ex) {
    toast(ex.message, "error");
    btn.disabled = false;
  }
}

// ----- Products -----

function viewProducts() {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="section-head">
      <h2>Products</h2>
      <button class="primary" id="add-product">+ Add product</button>
    </div>
    <div class="card">
      <table>
        <thead>
          <tr><th>Name</th><th>SKU</th><th class="right">Price</th><th class="right">Stock</th><th></th></tr>
        </thead>
        <tbody id="product-rows">
          ${state.products.length === 0
            ? `<tr><td colspan="5" class="muted" style="padding:24px">No products yet.</td></tr>`
            : state.products.map((p) => `
              <tr>
                <td>${escapeHtml(p.name)}</td>
                <td class="muted">${escapeHtml(p.sku || "—")}</td>
                <td class="right">${money(p.price)}</td>
                <td class="right">${p.stock === null || p.stock === undefined ? "—" : p.stock}</td>
                <td class="right">
                  <button data-edit="${p.id}">Edit</button>
                  <button class="danger" data-del="${p.id}">Delete</button>
                </td>
              </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  wrap.querySelector("#add-product").addEventListener("click", () => productModal());
  wrap.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => productModal(state.products.find((p) => p.id === b.dataset.edit)))
  );
  wrap.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => deleteProduct(b.dataset.del))
  );
  return wrap;
}

function productModal(existing) {
  const p = existing || {};
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal" id="product-modal">
      <h3>${existing ? "Edit product" : "Add product"}</h3>
      <div class="field"><label>Name</label><input id="p-name" value="${escapeAttr(p.name || "")}" required /></div>
      <div class="field"><label>Price</label><input id="p-price" type="number" step="0.01" min="0" value="${p.price ?? ""}" required /></div>
      <div class="field"><label>SKU (optional)</label><input id="p-sku" value="${escapeAttr(p.sku || "")}" /></div>
      <div class="field"><label>Stock (leave blank if not tracked)</label><input id="p-stock" type="number" step="1" value="${p.stock ?? ""}" /></div>
      <div class="error-text" id="p-error"></div>
      <div class="modal-actions">
        <button type="button" data-cancel>Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector("[data-cancel]").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelector("#product-modal").addEventListener("submit", async (e) => {
    e.preventDefault();
    const stockRaw = document.getElementById("p-stock").value.trim();
    const payload = {
      name: document.getElementById("p-name").value.trim(),
      price: parseFloat(document.getElementById("p-price").value),
      sku: document.getElementById("p-sku").value.trim() || undefined,
      stock: stockRaw === "" ? null : parseInt(stockRaw, 10),
    };
    try {
      if (existing) await api.put("/api/products/" + encodeURIComponent(existing.id), payload);
      else await api.post("/api/products", payload);
      close();
      await loadProducts();
      render();
      toast("Saved", "ok");
    } catch (ex) {
      document.getElementById("p-error").textContent = ex.message;
    }
  });
}

async function deleteProduct(id) {
  if (!confirm("Delete this product?")) return;
  try {
    await api.del("/api/products/" + encodeURIComponent(id));
    await loadProducts();
    render();
    toast("Deleted", "ok");
  } catch (ex) {
    toast(ex.message, "error");
  }
}

// ----- Reports -----

async function viewReports() {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="section-head"><h2>Today</h2></div><p class="muted">Loading…</p>`;
  try {
    const [report, recent] = await Promise.all([
      api.get("/api/reports/daily"),
      api.get("/api/sales"),
    ]);
    wrap.innerHTML = `
      <div class="section-head"><h2>Today — ${report.date}</h2></div>
      <div class="stat-row">
        <div class="stat"><div class="label">Sales total</div><div class="value">${money(report.total)}</div></div>
        <div class="stat"><div class="label">Transactions</div><div class="value">${report.count}</div></div>
        <div class="stat"><div class="label">Cash</div><div class="value">${money(report.byPayment.cash || 0)}</div></div>
        <div class="stat"><div class="label">Card</div><div class="value">${money(report.byPayment.card || 0)}</div></div>
      </div>
      <div class="section-head"><h2>Recent sales</h2></div>
      <div class="card">
        <table>
          <thead><tr><th>Time</th><th>Items</th><th>Payment</th><th>Cashier</th><th class="right">Total</th></tr></thead>
          <tbody>
            ${(recent.sales || []).length === 0
              ? `<tr><td colspan="5" class="muted" style="padding:24px">No sales yet.</td></tr>`
              : recent.sales.map((s) => `
                <tr>
                  <td>${new Date(s.createdAt).toLocaleString()}</td>
                  <td>${s.items.reduce((n, i) => n + i.qty, 0)} item(s)</td>
                  <td>${escapeHtml(s.payment)}</td>
                  <td class="muted">${escapeHtml(s.cashier || "—")}</td>
                  <td class="right">${money(s.total)}</td>
                </tr>`).join("")}
          </tbody>
        </table>
      </div>`;
  } catch (ex) {
    wrap.innerHTML = `<p class="error-text">${escapeHtml(ex.message)}</p>`;
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Data loading + render dispatch
// ---------------------------------------------------------------------------

async function loadProducts() {
  const data = await api.get("/api/products");
  state.products = (data.products || []).sort((a, b) => a.name.localeCompare(b.name));
}

function render() {
  if (!state.user || !api.token()) {
    renderLogin();
    return;
  }
  if (state.tab === "register") renderShell(viewRegister());
  else if (state.tab === "products") renderShell(viewProducts());
  else if (state.tab === "reports") {
    renderShell(document.createElement("div"));
    viewReports().then((el) => {
      const view = document.getElementById("view");
      if (view) { view.innerHTML = ""; view.appendChild(el); }
    });
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
    try { await loadProducts(); } catch (_) {}
  }
  render();
})();
