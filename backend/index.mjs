// Retail management API — single Lambda function.
//
// Exposed through a Lambda Function URL (no API Gateway) to keep cost at zero.
// Storage is one DynamoDB table (single-table design). Auth is a hand-rolled
// HMAC-SHA256 JWT so we don't need Cognito for a shop with a handful of users.
//
// Two roles:
//   manager  — products, cost of goods, stock adjustments, refunds, reports, users
//   operator — rings up sales and sees their own sales for today
//
// Money is Indonesian Rupiah (IDR), stored as whole numbers.
//
// No third-party npm dependencies: @aws-sdk/* and node:crypto are both part of
// the Lambda Node.js runtime, so deployment is just uploading these files.

import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.TABLE_NAME;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SHOP_NAME = process.env.SHOP_NAME || "My Shop";
// Minutes east of UTC for the shop's local day boundaries. 420 = WIB (UTC+7).
const TZ_OFFSET_MIN = Number(process.env.SHOP_TZ_OFFSET_MINUTES ?? 420);
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

const ROLES = ["manager", "operator"];
const PAYMENTS = ["cash", "card", "qris", "transfer", "other"];
const ADJUST_REASONS = ["receive", "count", "damage", "adjust"];

// DYNAMODB_ENDPOINT is only set for local development and tests.
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(
    process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}
  ),
  { marshallOptions: { removeUndefinedValues: true } }
);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS },
    body: JSON.stringify(body),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

// Rupiah has no minor unit in practice, so every amount is a whole number.
function idr(n) {
  return Math.round(Number(n) || 0);
}

function isTracked(product) {
  return typeof product?.stock === "number";
}

// Older records used "admin" / "cashier"; map them onto the two current roles.
function normRole(role) {
  return role === "manager" || role === "admin" ? "manager" : "operator";
}

// ---------------------------------------------------------------------------
// Shop-local dates. Sale sort keys are UTC ISO timestamps; these helpers turn
// a local YYYY-MM-DD into the UTC instant where that day starts.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localDate(at = new Date()) {
  return new Date(at.getTime() + TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayStartUtc(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - TZ_OFFSET_MIN * 60_000).toISOString();
}

function parseRange(query) {
  const today = localDate();
  const from = query.from || query.date || today;
  const to = query.to || query.date || from;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new HttpError(400, "dates must be YYYY-MM-DD");
  if (from > to) throw new HttpError(400, "'from' must not be after 'to'");
  return { from, to, start: dayStartUtc(from), end: dayStartUtc(addDays(to, 1)) };
}

// ---------------------------------------------------------------------------
// Auth: password hashing + JWT
// ---------------------------------------------------------------------------

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const derived = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
  const a = Buffer.from(derived);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(
    JSON.stringify({ ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS })
  );
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Verifies the token, then re-reads the user so a role change or deactivation
// takes effect immediately rather than when the token expires.
async function requireAuth(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  const payload = verifyToken(header.startsWith("Bearer ") ? header.slice(7) : null);
  if (!payload) return null;
  const user = await getUser(payload.sub);
  if (!user || user.active === false) return null;
  return { username: user.username, role: normRole(user.role) };
}

function requireManager(auth) {
  if (auth.role !== "manager") throw new HttpError(403, "manager access required");
}

function publicUser(user) {
  return {
    username: user.username,
    role: normRole(user.role),
    active: user.active !== false,
    createdAt: user.createdAt,
  };
}

function settings() {
  return { shopName: SHOP_NAME, currency: "IDR", tzOffsetMinutes: TZ_OFFSET_MIN, today: localDate() };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function getItem(pk, sk) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }));
  return res.Item;
}

function getUser(username) {
  return getItem("USER", String(username || ""));
}

function getProduct(id) {
  return getItem("PRODUCT", String(id || ""));
}

// On a fresh deploy there are no users. Seed the manager account from the
// ADMIN_USERNAME / ADMIN_PASSWORD env vars the first time it logs in.
async function ensureAdminSeed() {
  if (!ADMIN_PASSWORD) return;
  const existing = await getUser(ADMIN_USERNAME);
  if (existing) return;
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: "USER",
        sk: ADMIN_USERNAME,
        username: ADMIN_USERNAME,
        password: hashPassword(ADMIN_PASSWORD),
        role: "manager",
        active: true,
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(pk)",
    })
  ).catch(() => {}); // ignore race if two cold starts seed at once
}

// Queries one partition, following pagination up to `max` items.
async function queryAll(pk, { forward = true, beginsWith, between, max = 5000 } = {}) {
  const values = { ":pk": pk };
  let cond = "pk = :pk";
  if (beginsWith) {
    cond += " AND begins_with(sk, :sk)";
    values[":sk"] = beginsWith;
  } else if (between) {
    cond += " AND sk BETWEEN :a AND :b";
    values[":a"] = between[0];
    values[":b"] = between[1];
  }
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: cond,
        ExpressionAttributeValues: values,
        ScanIndexForward: forward,
        Limit: Math.min(1000, max - items.length),
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < max);
  return items;
}

// Adds `delta` to a product's stock. An untracked product starts tracking at
// `delta`. Returns the stock after the change, or null if the product is gone.
async function changeStock(productId, delta) {
  const tracked = {
    UpdateExpression: "SET stock = stock + :q",
    ConditionExpression: "attribute_exists(pk) AND attribute_type(stock, :n)",
    ExpressionAttributeValues: { ":q": delta, ":n": "N" },
  };
  const untracked = {
    UpdateExpression: "SET stock = :q",
    ConditionExpression: "attribute_exists(pk) AND NOT attribute_type(stock, :n)",
    ExpressionAttributeValues: { ":q": delta, ":n": "N" },
  };
  for (const variant of [tracked, untracked]) {
    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: "PRODUCT", sk: productId },
          ReturnValues: "ALL_NEW",
          ...variant,
        })
      );
      return res.Attributes.stock;
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
    }
  }
  return null;
}

// Sales only move stock for products that already track it.
async function changeTrackedStock(productId, delta) {
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: "PRODUCT", sk: productId },
        UpdateExpression: "SET stock = stock + :q",
        ConditionExpression: "attribute_exists(pk) AND attribute_type(stock, :n)",
        ExpressionAttributeValues: { ":q": delta, ":n": "N" },
      })
    )
    .catch((err) => {
      if (err.name !== "ConditionalCheckFailedException") throw err;
    });
}

// Remove the internal pk/sk and password before returning items to the client.
function stripKeys(item) {
  const { pk, sk, password, ...rest } = item;
  return rest;
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

async function handleLogin(body) {
  const { username, password } = body;
  if (!username || !password) return json(400, { error: "username and password required" });
  await ensureAdminSeed();
  const user = await getUser(username);
  if (!user || user.active === false || !verifyPassword(password, user.password)) {
    return json(401, { error: "invalid credentials" });
  }
  const role = normRole(user.role);
  const token = signToken({ sub: user.username, role });
  return json(200, { token, user: { username: user.username, role }, settings: settings() });
}

async function getMe(auth) {
  return json(200, { user: auth, settings: settings() });
}

async function changeOwnPassword(body, auth) {
  const user = await getUser(auth.username);
  if (!verifyPassword(String(body.current || ""), user.password)) {
    return json(400, { error: "current password is wrong" });
  }
  const next = String(body.next || "");
  if (next.length < 8) return json(400, { error: "new password must be at least 8 characters" });
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: "USER", sk: auth.username },
      UpdateExpression: "SET password = :p",
      ExpressionAttributeValues: { ":p": hashPassword(next) },
    })
  );
  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Users (manager only)
// ---------------------------------------------------------------------------

async function listUsers() {
  const users = await queryAll("USER");
  return json(200, { users: users.map(publicUser) });
}

async function createUser(body) {
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const role = body.role;
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return json(400, { error: "username must be 3-32 letters, numbers, dots, dashes or underscores" });
  }
  if (password.length < 8) return json(400, { error: "password must be at least 8 characters" });
  if (!ROLES.includes(role)) return json(400, { error: "role must be manager or operator" });
  const item = {
    pk: "USER",
    sk: username,
    username,
    password: hashPassword(password),
    role,
    active: true,
    createdAt: new Date().toISOString(),
  };
  try {
    await ddb.send(
      new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: "attribute_not_exists(pk)" })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return json(409, { error: "username already exists" });
    throw err;
  }
  return json(201, { user: publicUser(item) });
}

// Refuses changes that would leave the shop with no active manager.
async function assertManagerRemains(excluding) {
  const users = await queryAll("USER");
  const others = users.filter(
    (u) => u.username !== excluding && u.active !== false && normRole(u.role) === "manager"
  );
  if (others.length === 0) throw new HttpError(400, "the shop needs at least one active manager");
}

async function updateUser(username, body, auth) {
  const user = await getUser(username);
  if (!user) return json(404, { error: "user not found" });
  const demoting = body.role !== undefined && body.role !== "manager" && normRole(user.role) === "manager";
  const deactivating = body.active === false && user.active !== false;
  if (body.role !== undefined && !ROLES.includes(body.role)) {
    return json(400, { error: "role must be manager or operator" });
  }
  if ((demoting || deactivating) && username === auth.username) {
    return json(400, { error: "you cannot demote or deactivate yourself" });
  }
  if ((demoting || deactivating) && normRole(user.role) === "manager") await assertManagerRemains(username);

  if (body.role !== undefined) user.role = body.role;
  if (body.active !== undefined) user.active = Boolean(body.active);
  if (body.password !== undefined) {
    if (String(body.password).length < 8) return json(400, { error: "password must be at least 8 characters" });
    user.password = hashPassword(String(body.password));
  }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: user }));
  return json(200, { user: publicUser(user) });
}

async function deleteUser(username, auth) {
  if (username === auth.username) return json(400, { error: "you cannot delete yourself" });
  const user = await getUser(username);
  if (!user) return json(404, { error: "user not found" });
  if (normRole(user.role) === "manager") await assertManagerRemains(username);
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: "USER", sk: username } }));
  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

// Operators never see cost of goods.
function productView(item, role) {
  const p = stripKeys(item);
  if (!isTracked(p)) p.stock = null;
  if (role !== "manager") delete p.cost;
  return p;
}

async function listProducts(auth) {
  const items = await queryAll("PRODUCT");
  return json(200, { products: items.map((p) => productView(p, auth.role)) });
}

function cleanProductFields(body) {
  const fields = {
    name: String(body.name || "").trim(),
    sku: body.sku ? String(body.sku).trim() : undefined,
    category: body.category ? String(body.category).trim() : undefined,
    price: idr(body.price),
    cost: idr(body.cost),
    lowStock: body.lowStock === undefined || body.lowStock === null || body.lowStock === ""
      ? 5
      : Math.max(0, Math.round(Number(body.lowStock) || 0)),
  };
  if (!fields.name) throw new HttpError(400, "name required");
  if (fields.price < 0 || fields.cost < 0) throw new HttpError(400, "price and cost cannot be negative");
  return fields;
}

async function assertSkuFree(sku, exceptId) {
  if (!sku) return;
  const products = await queryAll("PRODUCT");
  const clash = products.find((p) => p.sku && p.sku.toLowerCase() === sku.toLowerCase() && p.id !== exceptId);
  if (clash) throw new HttpError(409, `SKU ${sku} is already used by ${clash.name}`);
}

async function createProduct(body) {
  const fields = cleanProductFields(body);
  await assertSkuFree(fields.sku);
  const id = newId("prod");
  const now = new Date().toISOString();
  const hasStock = body.stock !== undefined && body.stock !== null && body.stock !== "";
  const track = body.trackStock === undefined ? hasStock : Boolean(body.trackStock);
  const item = {
    pk: "PRODUCT",
    sk: id,
    id,
    ...fields,
    stock: track ? Math.round(Number(body.stock) || 0) : undefined,
    createdAt: now,
    updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return json(201, { product: productView(item, "manager") });
}

// Edits never overwrite the stock count; that goes through stock adjustments
// so every change has a reason on record. Only tracking can be switched.
async function updateProduct(id, body) {
  const existing = await getProduct(id);
  if (!existing) return json(404, { error: "product not found" });
  const fields = cleanProductFields({ ...stripKeys(existing), ...body });
  await assertSkuFree(fields.sku, id);

  const sets = ["#name = :name", "price = :price", "cost = :cost", "lowStock = :lowStock", "updatedAt = :now"];
  const removes = [];
  const values = {
    ":name": fields.name,
    ":price": fields.price,
    ":cost": fields.cost,
    ":lowStock": fields.lowStock,
    ":now": new Date().toISOString(),
  };
  for (const key of ["sku", "category"]) {
    if (fields[key]) {
      sets.push(`${key} = :${key}`);
      values[`:${key}`] = fields[key];
    } else {
      removes.push(key);
    }
  }
  if (body.trackStock === true && !isTracked(existing)) {
    sets.push("stock = :zero");
    values[":zero"] = 0;
  } else if (body.trackStock === false) {
    removes.push("stock");
  }
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: "PRODUCT", sk: id },
      UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return json(200, { product: productView(res.Attributes, "manager") });
}

async function deleteProduct(id) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: "PRODUCT", sk: id } }));
  return json(200, { ok: true });
}

// Bulk create/update from CSV rows (parsed in the browser). Rows whose SKU
// matches an existing product update it; stock is only set for new products.
async function importProducts(body) {
  const rows = Array.isArray(body.products) ? body.products : [];
  if (rows.length === 0) return json(400, { error: "no rows to import" });
  if (rows.length > 1000) return json(400, { error: "import at most 1000 rows at a time" });

  const existing = await queryAll("PRODUCT");
  const bySku = new Map(existing.filter((p) => p.sku).map((p) => [p.sku.toLowerCase(), p]));
  const result = { created: 0, updated: 0, errors: [] };
  const now = new Date().toISOString();

  for (const [i, row] of rows.entries()) {
    try {
      // Blank cells keep the existing value when updating.
      const given = Object.fromEntries(
        Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== "")
      );
      const sku = given.sku ? String(given.sku).trim() : "";
      const match = sku && bySku.get(sku.toLowerCase());
      const fields = cleanProductFields(match ? { ...stripKeys(match), ...given } : given);
      if (match) {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { pk: "PRODUCT", sk: match.id },
            UpdateExpression:
              "SET #name = :name, price = :price, cost = :cost, lowStock = :lowStock, category = :category, updatedAt = :now",
            ExpressionAttributeNames: { "#name": "name" },
            ExpressionAttributeValues: {
              ":name": fields.name,
              ":price": fields.price,
              ":cost": fields.cost,
              ":lowStock": fields.lowStock,
              ":category": fields.category || null,
              ":now": now,
            },
          })
        );
        result.updated++;
      } else {
        const id = newId("prod");
        const item = {
          pk: "PRODUCT",
          sk: id,
          id,
          ...fields,
          stock: given.stock !== undefined ? Math.round(Number(given.stock) || 0) : undefined,
          createdAt: now,
          updatedAt: now,
        };
        await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
        if (fields.sku) bySku.set(fields.sku.toLowerCase(), item);
        result.created++;
      }
    } catch (err) {
      result.errors.push({ row: i + 1, error: err.message });
    }
  }
  return json(200, result);
}

// ---------------------------------------------------------------------------
// Stock adjustments (manager only)
// ---------------------------------------------------------------------------

async function adjustStock(body, auth) {
  const product = await getProduct(body.productId);
  if (!product) return json(404, { error: "product not found" });
  const reason = body.reason;
  if (!ADJUST_REASONS.includes(reason)) return json(400, { error: "unknown adjustment reason" });

  const before = isTracked(product) ? product.stock : 0;
  let delta;
  if (reason === "count") {
    const counted = Number(body.countedQty);
    if (!Number.isInteger(counted) || counted < 0) return json(400, { error: "counted quantity must be a whole number" });
    delta = counted - before;
  } else {
    delta = Number(body.qty);
    if (!Number.isInteger(delta) || delta === 0) return json(400, { error: "quantity must be a non-zero whole number" });
    if (reason === "receive" && delta < 0) return json(400, { error: "received quantity must be positive" });
    if (reason === "damage") delta = -Math.abs(delta);
  }

  const stockAfter = await changeStock(product.id, delta);
  if (stockAfter === null) return json(404, { error: "product not found" });

  // Receiving at a new unit cost updates cost of goods as a weighted average.
  let unitCost;
  if (reason === "receive" && body.unitCost !== undefined && body.unitCost !== "" && body.unitCost !== null) {
    unitCost = idr(body.unitCost);
    if (unitCost < 0) return json(400, { error: "unit cost cannot be negative" });
    const onHand = Math.max(0, stockAfter - delta);
    const newCost = onHand > 0
      ? idr((onHand * (product.cost || 0) + delta * unitCost) / (onHand + delta))
      : unitCost;
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: "PRODUCT", sk: product.id },
        UpdateExpression: "SET cost = :c, updatedAt = :now",
        ExpressionAttributeValues: { ":c": newCost, ":now": new Date().toISOString() },
      })
    );
  }

  const now = new Date().toISOString();
  const moveId = newId("move");
  const move = {
    pk: "MOVE",
    sk: `${now}#${moveId}`,
    id: moveId,
    productId: product.id,
    productName: product.name,
    reason,
    qty: delta,
    stockAfter,
    unitCost,
    note: body.note ? String(body.note).slice(0, 200) : undefined,
    by: auth.username,
    createdAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: move }));
  return json(201, { movement: stripKeys(move), stock: stockAfter });
}

async function listMovements(query) {
  const { start, end } = parseRange({ from: query.from || addDays(localDate(), -30), to: query.to });
  const items = await queryAll("MOVE", { between: [start, end], forward: false, max: 1000 });
  return json(200, { movements: items.map(stripKeys) });
}

// ---------------------------------------------------------------------------
// Sales and refunds
// ---------------------------------------------------------------------------

// Prices and costs come from the product records, never from the browser.
async function recordSale(body, auth) {
  const lines = Array.isArray(body.items) ? body.items : [];
  if (lines.length === 0) return json(400, { error: "sale must have at least one item" });

  const qtyById = new Map();
  for (const l of lines) {
    const qty = Number(l.qty);
    if (!l.productId || !Number.isInteger(qty) || qty <= 0) {
      return json(400, { error: "each item needs a product and a whole-number quantity" });
    }
    qtyById.set(l.productId, (qtyById.get(l.productId) || 0) + qty);
  }

  const items = [];
  for (const [productId, qty] of qtyById) {
    const p = await getProduct(productId);
    if (!p) return json(400, { error: "a product in the cart no longer exists; refresh and try again" });
    items.push({
      productId,
      name: p.name,
      sku: p.sku,
      category: p.category,
      price: p.price || 0,
      cost: p.cost || 0,
      qty,
    });
  }

  const subtotal = items.reduce((s, l) => s + l.price * l.qty, 0);
  const discount = idr(body.discount);
  if (discount < 0 || discount > subtotal) return json(400, { error: "discount must be between 0 and the subtotal" });
  const total = subtotal - discount;
  const payment = PAYMENTS.includes(body.payment) ? body.payment : "cash";

  let cashReceived;
  let change;
  if (payment === "cash" && body.cashReceived !== undefined && body.cashReceived !== null && body.cashReceived !== "") {
    cashReceived = idr(body.cashReceived);
    if (cashReceived < total) return json(400, { error: "cash received is less than the total" });
    change = cashReceived - total;
  }

  const now = new Date();
  const saleId = newId("sale");
  const sale = {
    pk: "SALE",
    // Sort key sorts chronologically so date-range queries are trivial.
    sk: `${now.toISOString()}#${saleId}`,
    id: saleId,
    items,
    subtotal,
    discount,
    total,
    cogs: items.reduce((s, l) => s + l.cost * l.qty, 0),
    payment,
    cashReceived,
    change,
    cashier: auth.username,
    createdAt: now.toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: sale }));
  await Promise.all(items.map((l) => changeTrackedStock(l.productId, -l.qty)));
  return json(201, { sale: stripKeys(sale) });
}

async function listSales(query, auth) {
  // Operators only see their own sales for today.
  const range = auth.role === "manager" ? parseRange(query) : parseRange({});
  const [sales, refunds] = await Promise.all([
    queryAll("SALE", { between: [range.start, range.end], forward: false }),
    auth.role === "manager"
      ? queryAll("REFUND", { between: [range.start, range.end], forward: false })
      : [],
  ]);
  const visible = auth.role === "manager" ? sales : sales.filter((s) => s.cashier === auth.username);
  const out = visible.map(stripKeys);
  if (auth.role !== "manager") {
    for (const s of out) {
      delete s.cogs;
      for (const l of s.items) delete l.cost;
    }
  }
  return json(200, { from: range.from, to: range.to, sales: out, refunds: refunds.map(stripKeys) });
}

// Refunds a quantity of one or more lines from an earlier sale. The refunded
// amount is the line value less its share of the sale's discount.
async function refundSale(body, auth) {
  const sale = body.createdAt && body.saleId ? await getItem("SALE", `${body.createdAt}#${body.saleId}`) : null;
  if (!sale) return json(404, { error: "sale not found" });

  const refunded = { ...(sale.refundedQty || {}) };
  const lines = [];
  for (const req of Array.isArray(body.items) ? body.items : []) {
    const qty = Number(req.qty);
    if (!Number.isInteger(qty) || qty <= 0) continue;
    const line = sale.items.find((l) => l.productId === req.productId);
    if (!line) return json(400, { error: "item is not on this sale" });
    const left = line.qty - (refunded[line.productId] || 0);
    if (qty > left) return json(400, { error: `only ${left} of ${line.name} can still be refunded` });
    refunded[line.productId] = (refunded[line.productId] || 0) + qty;
    lines.push({ productId: line.productId, name: line.name, category: line.category, price: line.price, cost: line.cost, qty });
  }
  if (lines.length === 0) return json(400, { error: "choose at least one item to refund" });

  const share = sale.subtotal > 0 ? sale.total / sale.subtotal : 0;
  const amount = idr(lines.reduce((s, l) => s + l.price * l.qty, 0) * share);
  const cogs = lines.reduce((s, l) => s + l.cost * l.qty, 0);
  const version = sale.version || 0;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: "SALE", sk: sale.sk },
        UpdateExpression: "SET refundedQty = :r, refundTotal = :t, version = :v1",
        ConditionExpression: version === 0 ? "attribute_not_exists(version)" : "version = :v0",
        ExpressionAttributeValues: {
          ":r": refunded,
          ":t": (sale.refundTotal || 0) + amount,
          ":v1": version + 1,
          ...(version === 0 ? {} : { ":v0": version }),
        },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(409, { error: "this sale was changed by someone else; reload and try again" });
    }
    throw err;
  }

  const now = new Date().toISOString();
  const refundId = newId("refund");
  const refund = {
    pk: "REFUND",
    sk: `${now}#${refundId}`,
    id: refundId,
    saleId: sale.id,
    saleCreatedAt: sale.createdAt,
    items: lines,
    amount,
    cogs,
    payment: sale.payment,
    reason: body.reason ? String(body.reason).slice(0, 200) : undefined,
    by: auth.username,
    createdAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: refund }));
  if (body.restock !== false) {
    await Promise.all(lines.map((l) => changeTrackedStock(l.productId, l.qty)));
  }
  return json(201, { refund: stripKeys(refund) });
}

// ---------------------------------------------------------------------------
// Reports (manager only)
// ---------------------------------------------------------------------------

async function summaryReport(query) {
  const range = parseRange(query);
  const [sales, refunds] = await Promise.all([
    queryAll("SALE", { between: [range.start, range.end], max: 50000 }),
    queryAll("REFUND", { between: [range.start, range.end], max: 50000 }),
  ]);

  const r = {
    from: range.from,
    to: range.to,
    count: sales.length,
    grossSales: 0,
    discounts: 0,
    refunds: 0,
    netSales: 0,
    cogs: 0,
    grossProfit: 0,
    margin: 0,
    averageSale: 0,
    byPayment: {},
    byDay: [],
    byCategory: [],
    bestSellers: [],
  };
  const days = new Map();
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    days.set(d, { date: d, count: 0, netSales: 0, grossProfit: 0 });
  }
  const products = new Map();
  const categories = new Map();
  const bump = (map, key, init) => {
    if (!map.has(key)) map.set(key, init());
    return map.get(key);
  };

  for (const s of sales) {
    const share = s.subtotal > 0 ? s.total / s.subtotal : 0;
    const cogs = s.cogs || 0;
    r.grossSales += s.subtotal || 0;
    r.discounts += s.discount || 0;
    r.netSales += s.total || 0;
    r.cogs += cogs;
    r.byPayment[s.payment] = (r.byPayment[s.payment] || 0) + (s.total || 0);
    const day = days.get(localDate(new Date(s.createdAt)));
    if (day) {
      day.count++;
      day.netSales += s.total || 0;
      day.grossProfit += (s.total || 0) - cogs;
    }
    for (const l of s.items || []) {
      const revenue = l.price * l.qty * share;
      const p = bump(products, l.productId || l.name, () => ({ productId: l.productId, name: l.name, qty: 0, revenue: 0, profit: 0 }));
      p.qty += l.qty;
      p.revenue += revenue;
      p.profit += revenue - (l.cost || 0) * l.qty;
      const c = bump(categories, l.category || "Uncategorized", () => ({ category: l.category || "Uncategorized", qty: 0, revenue: 0 }));
      c.qty += l.qty;
      c.revenue += revenue;
    }
  }

  for (const f of refunds) {
    r.refunds += f.amount || 0;
    r.netSales -= f.amount || 0;
    r.cogs -= f.cogs || 0;
    r.byPayment[f.payment] = (r.byPayment[f.payment] || 0) - (f.amount || 0);
    const day = days.get(localDate(new Date(f.createdAt)));
    if (day) {
      day.netSales -= f.amount || 0;
      day.grossProfit -= (f.amount || 0) - (f.cogs || 0);
    }
    const lineTotal = f.items.reduce((s, l) => s + l.price * l.qty, 0) || 1;
    for (const l of f.items || []) {
      const revenue = (f.amount * l.price * l.qty) / lineTotal;
      const p = bump(products, l.productId || l.name, () => ({ productId: l.productId, name: l.name, qty: 0, revenue: 0, profit: 0 }));
      p.qty -= l.qty;
      p.revenue -= revenue;
      p.profit -= revenue - (l.cost || 0) * l.qty;
      const c = bump(categories, l.category || "Uncategorized", () => ({ category: l.category || "Uncategorized", qty: 0, revenue: 0 }));
      c.qty -= l.qty;
      c.revenue -= revenue;
    }
  }

  r.grossProfit = r.netSales - r.cogs;
  r.margin = r.netSales > 0 ? Math.round((r.grossProfit / r.netSales) * 1000) / 10 : 0;
  r.averageSale = r.count > 0 ? idr(r.netSales / r.count) : 0;
  r.byDay = [...days.values()].map((d) => ({ ...d, netSales: idr(d.netSales), grossProfit: idr(d.grossProfit) }));
  r.bestSellers = [...products.values()]
    .map((p) => ({ ...p, revenue: idr(p.revenue), profit: idr(p.profit) }))
    .filter((p) => p.qty > 0)
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)
    .slice(0, 10);
  r.byCategory = [...categories.values()]
    .map((c) => ({ ...c, revenue: idr(c.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);
  for (const k of Object.keys(r.byPayment)) r.byPayment[k] = idr(r.byPayment[k]);
  return json(200, r);
}

async function stockReport() {
  const products = (await queryAll("PRODUCT")).filter(isTracked);
  const lowStock = products
    .filter((p) => p.stock <= (p.lowStock ?? 5))
    .sort((a, b) => a.stock - b.stock)
    .map((p) => ({ id: p.id, name: p.name, sku: p.sku, stock: p.stock, lowStock: p.lowStock ?? 5 }));
  return json(200, {
    trackedProducts: products.length,
    units: products.reduce((s, p) => s + Math.max(0, p.stock), 0),
    costValue: products.reduce((s, p) => s + Math.max(0, p.stock) * (p.cost || 0), 0),
    retailValue: products.reduce((s, p) => s + Math.max(0, p.stock) * (p.price || 0), 0),
    outOfStock: products.filter((p) => p.stock <= 0).length,
    lowStock,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(method, path, query, body, event) {
  // Public routes
  if (path === "/api/login" && method === "POST") return handleLogin(body);
  if (path === "/" || path === "/health") return json(200, { ok: true, service: "posmp" });

  // Everything below requires a valid token.
  const auth = await requireAuth(event);
  if (!auth) return json(401, { error: "unauthorized" });

  if (path === "/api/me" && method === "GET") return getMe(auth);
  if (path === "/api/me/password" && method === "POST") return changeOwnPassword(body, auth);

  if (path === "/api/products" && method === "GET") return listProducts(auth);
  if (path === "/api/sales" && method === "POST") return recordSale(body, auth);
  if (path === "/api/sales" && method === "GET") return listSales(query, auth);

  // Manager-only from here on.
  requireManager(auth);

  if (path === "/api/products" && method === "POST") return createProduct(body);
  if (path === "/api/products/import" && method === "POST") return importProducts(body);
  const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch) {
    const id = decodeURIComponent(productMatch[1]);
    if (method === "PUT") return updateProduct(id, body);
    if (method === "DELETE") return deleteProduct(id);
  }

  if (path === "/api/stock/adjust" && method === "POST") return adjustStock(body, auth);
  if (path === "/api/stock/movements" && method === "GET") return listMovements(query);
  if (path === "/api/refunds" && method === "POST") return refundSale(body, auth);
  if (path === "/api/reports/summary" && method === "GET") return summaryReport(query);
  if (path === "/api/reports/daily" && method === "GET") return summaryReport({ date: query.date });
  if (path === "/api/reports/stock" && method === "GET") return stockReport();

  if (path === "/api/users" && method === "GET") return listUsers();
  if (path === "/api/users" && method === "POST") return createUser(body);
  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    const username = decodeURIComponent(userMatch[1]);
    if (method === "PUT") return updateUser(username, body, auth);
    if (method === "DELETE") return deleteUser(username, auth);
  }

  return json(404, { error: "not found", path });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = (event.rawPath || "/").replace(/\/+$/, "") || "/";
  const query = event.queryStringParameters || {};

  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  let body = {};
  if (event.body) {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString()
        : event.body;
      body = JSON.parse(raw || "{}");
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
  }

  try {
    return await route(method, path, query, body, event);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error("handler error", err);
    return json(500, { error: "internal error" });
  }
};
