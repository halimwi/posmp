// API tests: the real Lambda handler against an in-memory DynamoDB.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startDynamo } from "../dev/dynamo.mjs";

let dynamo;
let handler;

before(async () => {
  dynamo = await startDynamo("posmp-test");
  process.env.ADMIN_USERNAME = "boss";
  process.env.ADMIN_PASSWORD = "bosspass123";
  process.env.JWT_SECRET = "test-secret-0123456789";
  process.env.SHOP_TZ_OFFSET_MINUTES = "420";
  ({ handler } = await import("../backend/index.mjs"));
});

after(() => dynamo.close());

async function call(method, path, { token, body, query } = {}) {
  const res = await handler({
    rawPath: path,
    requestContext: { http: { method } },
    headers: token ? { authorization: `Bearer ${token}` } : {},
    queryStringParameters: query,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

async function login(username, password) {
  const res = await call("POST", "/api/login", { body: { username, password } });
  assert.equal(res.status, 200, res.body.error);
  return res.body.token;
}

let manager;
let operator;
let rice;
let soap;

test("seeded admin signs in as a manager", async () => {
  const res = await call("POST", "/api/login", { body: { username: "boss", password: "bosspass123" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, "manager");
  assert.equal(res.body.settings.currency, "IDR");
  manager = res.body.token;
});

test("manager creates an operator", async () => {
  const res = await call("POST", "/api/users", {
    token: manager,
    body: { username: "Siti", password: "operator123", role: "operator" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.username, "siti");
  operator = await login("siti", "operator123");
});

test("manager adds products with cost of goods", async () => {
  let res = await call("POST", "/api/products", {
    token: manager,
    body: { name: "Beras 5kg", sku: "BRS5", category: "Groceries", price: 75000, cost: 62000, trackStock: true, stock: 10, lowStock: 3 },
  });
  assert.equal(res.status, 201);
  rice = res.body.product;
  assert.equal(rice.cost, 62000);

  res = await call("POST", "/api/products", {
    token: manager,
    body: { name: "Sabun", sku: "SBN", category: "Household", price: 4500.4, cost: 3000, trackStock: true, stock: 40 },
  });
  soap = res.body.product;
  assert.equal(soap.price, 4500, "IDR is rounded to whole rupiah");

  res = await call("POST", "/api/products", { token: manager, body: { name: "Dup", sku: "brs5", price: 1 } });
  assert.equal(res.status, 409, "SKU must be unique");
});

test("operator sees products without cost and cannot edit them", async () => {
  let res = await call("GET", "/api/products", { token: operator });
  assert.equal(res.status, 200);
  assert.ok(res.body.products.every((p) => !("cost" in p)));

  res = await call("PUT", `/api/products/${rice.id}`, { token: operator, body: { price: 1 } });
  assert.equal(res.status, 403);
  res = await call("POST", "/api/stock/adjust", { token: operator, body: { productId: rice.id, reason: "receive", qty: 5 } });
  assert.equal(res.status, 403);
  res = await call("GET", "/api/reports/summary", { token: operator });
  assert.equal(res.status, 403);
  res = await call("GET", "/api/users", { token: operator });
  assert.equal(res.status, 403);
});

test("receiving stock at a new cost updates cost as a weighted average", async () => {
  const res = await call("POST", "/api/stock/adjust", {
    token: manager,
    body: { productId: rice.id, reason: "receive", qty: 10, unitCost: 64000, note: "PO 12" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.stock, 20);
  const products = (await call("GET", "/api/products", { token: manager })).body.products;
  assert.equal(products.find((p) => p.id === rice.id).cost, 63000);
});

test("stock count sets the absolute quantity", async () => {
  const res = await call("POST", "/api/stock/adjust", {
    token: manager,
    body: { productId: soap.id, reason: "count", countedQty: 38 },
  });
  assert.equal(res.body.stock, 38);
  assert.equal(res.body.movement.qty, -2);
});

let sale;

test("operator records a sale; prices come from the server", async () => {
  const res = await call("POST", "/api/sales", {
    token: operator,
    body: {
      items: [
        { productId: rice.id, qty: 2, price: 1 },
        { productId: soap.id, qty: 3 },
      ],
      discount: 4000,
      payment: "cash",
      cashReceived: 200000,
    },
  });
  assert.equal(res.status, 201, res.body.error);
  sale = res.body.sale;
  assert.equal(sale.subtotal, 2 * 75000 + 3 * 4500);
  assert.equal(sale.total, 163500 - 4000);
  assert.equal(sale.change, 200000 - 159500);
  assert.equal(sale.cashier, "siti");
  assert.equal(sale.cogs, 2 * 63000 + 3 * 3000);

  const products = (await call("GET", "/api/products", { token: manager })).body.products;
  assert.equal(products.find((p) => p.id === rice.id).stock, 18);
  assert.equal(products.find((p) => p.id === soap.id).stock, 35);
});

test("operator sees only their own sales, without cost", async () => {
  await call("POST", "/api/sales", { token: manager, body: { items: [{ productId: soap.id, qty: 1 }], payment: "qris" } });
  const res = await call("GET", "/api/sales", { token: operator });
  assert.equal(res.body.sales.length, 1);
  assert.equal(res.body.sales[0].cogs, undefined);
  assert.equal(res.body.sales[0].items[0].cost, undefined);
  const all = await call("GET", "/api/sales", { token: manager });
  assert.equal(all.body.sales.length, 2);
});

test("discount cannot exceed the subtotal and cash must cover the total", async () => {
  let res = await call("POST", "/api/sales", { token: operator, body: { items: [{ productId: soap.id, qty: 1 }], discount: 5000 } });
  assert.equal(res.status, 400);
  res = await call("POST", "/api/sales", { token: operator, body: { items: [{ productId: soap.id, qty: 1 }], payment: "cash", cashReceived: 1000 } });
  assert.equal(res.status, 400);
});

test("manager refunds part of a sale and stock returns", async () => {
  let res = await call("POST", "/api/refunds", {
    token: operator,
    body: { saleId: sale.id, createdAt: sale.createdAt, items: [{ productId: rice.id, qty: 1 }] },
  });
  assert.equal(res.status, 403, "operators cannot refund");

  res = await call("POST", "/api/refunds", {
    token: manager,
    body: { saleId: sale.id, createdAt: sale.createdAt, items: [{ productId: rice.id, qty: 1 }], reason: "damaged bag" },
  });
  assert.equal(res.status, 201, res.body.error);
  // 75,000 less its share of the 4,000 discount on a 163,500 subtotal.
  assert.equal(res.body.refund.amount, Math.round(75000 * (159500 / 163500)));

  res = await call("POST", "/api/refunds", {
    token: manager,
    body: { saleId: sale.id, createdAt: sale.createdAt, items: [{ productId: rice.id, qty: 2 }] },
  });
  assert.equal(res.status, 400, "cannot refund more than was sold");

  const products = (await call("GET", "/api/products", { token: manager })).body.products;
  assert.equal(products.find((p) => p.id === rice.id).stock, 19);
});

test("summary report nets refunds and computes profit", async () => {
  const res = await call("GET", "/api/reports/summary", { token: manager });
  assert.equal(res.status, 200);
  const r = res.body;
  const refund = Math.round(75000 * (159500 / 163500));
  assert.equal(r.count, 2);
  assert.equal(r.grossSales, 163500 + 4500);
  assert.equal(r.discounts, 4000);
  assert.equal(r.refunds, refund);
  assert.equal(r.netSales, 159500 + 4500 - refund);
  assert.equal(r.cogs, 2 * 63000 + 3 * 3000 + 3000 - 63000);
  assert.equal(r.grossProfit, r.netSales - r.cogs);
  assert.equal(r.byPayment.qris, 4500);
  assert.equal(r.bestSellers[0].name, "Sabun");
  assert.equal(r.bestSellers[0].qty, 4);
  assert.equal(r.byDay.length, 1);
});

test("stock report values inventory and flags low stock", async () => {
  await call("POST", "/api/stock/adjust", { token: manager, body: { productId: rice.id, reason: "damage", qty: 17, note: "flood" } });
  const res = await call("GET", "/api/reports/stock", { token: manager });
  assert.equal(res.status, 200);
  assert.equal(res.body.lowStock.length, 1);
  assert.equal(res.body.lowStock[0].stock, 2);
  assert.equal(res.body.costValue, 2 * 63000 + 34 * 3000);
});

test("CSV import creates new products and updates by SKU without wiping blanks", async () => {
  const res = await call("POST", "/api/products/import", {
    token: manager,
    body: {
      products: [
        { name: "Sabun Wangi", sku: "sbn", price: "5000", cost: "" },
        { name: "Gula 1kg", sku: "GL1", category: "Groceries", price: "18000", cost: "15000", stock: "24" },
        { name: "", price: "1" },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.created, res.body.updated, res.body.errors.length], [1, 1, 1]);
  const products = (await call("GET", "/api/products", { token: manager })).body.products;
  const updated = products.find((p) => p.id === soap.id);
  assert.equal(updated.name, "Sabun Wangi");
  assert.equal(updated.price, 5000);
  assert.equal(updated.cost, 3000, "blank cost keeps the old cost");
  assert.equal(updated.stock, 34, "import never overwrites stock of existing products");
  assert.equal(products.find((p) => p.sku === "GL1").stock, 24);
});

test("the last active manager cannot be demoted or deleted", async () => {
  let res = await call("PUT", "/api/users/boss", { token: manager, body: { role: "operator" } });
  assert.equal(res.status, 400);
  await call("POST", "/api/users", { token: manager, body: { username: "deputy", password: "deputy1234", role: "manager" } });
  const deputy = await login("deputy", "deputy1234");
  res = await call("DELETE", "/api/users/boss", { token: deputy });
  assert.equal(res.status, 200);
  res = await call("DELETE", "/api/users/deputy", { token: deputy });
  assert.equal(res.status, 400);
});

test("deactivated users are locked out immediately", async () => {
  const deputy = await login("deputy", "deputy1234");
  await call("PUT", "/api/users/siti", { token: deputy, body: { active: false } });
  const res = await call("GET", "/api/products", { token: operator });
  assert.equal(res.status, 401);
  const relogin = await call("POST", "/api/login", { body: { username: "siti", password: "operator123" } });
  assert.equal(relogin.status, 401);
});

test("users can change their own password", async () => {
  const deputy = await login("deputy", "deputy1234");
  let res = await call("POST", "/api/me/password", { token: deputy, body: { current: "wrong", next: "newpass1234" } });
  assert.equal(res.status, 400);
  res = await call("POST", "/api/me/password", { token: deputy, body: { current: "deputy1234", next: "newpass1234" } });
  assert.equal(res.status, 200);
  await login("deputy", "newpass1234");
});
