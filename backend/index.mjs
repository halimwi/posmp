// Point of Sale — single Lambda function.
//
// Exposed through a Lambda Function URL (no API Gateway) to keep cost at zero.
// Storage is one DynamoDB table (single-table design). Auth is a hand-rolled
// HMAC-SHA256 JWT so we don't need Cognito for a shop with a handful of users.
//
// No third-party npm dependencies: @aws-sdk/* and node:crypto are both part of
// the Lambda Node.js 20 runtime, so deployment is just uploading these files.

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
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

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

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Auth: password hashing + JWT
// ---------------------------------------------------------------------------

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(":");
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

function requireAuth(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return verifyToken(token);
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function getUser(username) {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: "USER", sk: username } })
  );
  return res.Item;
}

// On a fresh deploy there are no users. Seed the admin account from the
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
        role: "admin",
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(pk)",
    })
  ).catch(() => {}); // ignore race if two cold starts seed at once
}

async function listByPartition(pk, { limit, forward = true, beginsWith } = {}) {
  const params = {
    TableName: TABLE,
    KeyConditionExpression: beginsWith
      ? "pk = :pk AND begins_with(sk, :sk)"
      : "pk = :pk",
    ExpressionAttributeValues: beginsWith
      ? { ":pk": pk, ":sk": beginsWith }
      : { ":pk": pk },
    ScanIndexForward: forward,
  };
  if (limit) params.Limit = limit;
  const res = await ddb.send(new QueryCommand(params));
  return res.Items || [];
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleLogin(body) {
  const { username, password } = body;
  if (!username || !password) return json(400, { error: "username and password required" });
  await ensureAdminSeed();
  const user = await getUser(username);
  if (!user || !verifyPassword(password, user.password)) {
    return json(401, { error: "invalid credentials" });
  }
  const token = signToken({ sub: username, role: user.role || "cashier" });
  return json(200, { token, user: { username, role: user.role || "cashier" } });
}

async function listProducts() {
  const items = await listByPartition("PRODUCT");
  return json(200, { products: items.map(stripKeys) });
}

async function saveProduct(body, id) {
  const productId = id || newId("prod");
  const now = new Date().toISOString();
  const item = {
    pk: "PRODUCT",
    sk: productId,
    id: productId,
    name: String(body.name || "").trim(),
    price: Number(body.price) || 0,
    sku: body.sku ? String(body.sku).trim() : undefined,
    stock: body.stock === undefined || body.stock === null ? null : Number(body.stock),
    updatedAt: now,
  };
  if (!item.name) return json(400, { error: "name required" });
  if (!id) item.createdAt = now;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return json(id ? 200 : 201, { product: stripKeys(item) });
}

async function deleteProduct(id) {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: { pk: "PRODUCT", sk: id } })
  );
  return json(200, { ok: true });
}

async function recordSale(body, cashier) {
  const lines = Array.isArray(body.items) ? body.items : [];
  if (lines.length === 0) return json(400, { error: "sale must have at least one item" });

  const now = new Date();
  const saleId = newId("sale");
  const items = lines.map((l) => ({
    productId: l.productId || null,
    name: String(l.name || "item"),
    price: Number(l.price) || 0,
    qty: Number(l.qty) || 1,
  }));
  const subtotal = items.reduce((s, l) => s + l.price * l.qty, 0);
  const tax = Number(body.tax) || 0;
  const total = Math.round((subtotal + tax) * 100) / 100;

  const sale = {
    pk: "SALE",
    // Sort key sorts chronologically so recent-first queries are trivial.
    sk: `${now.toISOString()}#${saleId}`,
    id: saleId,
    items,
    subtotal,
    tax,
    total,
    payment: body.payment || "cash",
    cashier: cashier || "unknown",
    createdAt: now.toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: sale }));

  // Best-effort inventory decrement for tracked products.
  await Promise.all(
    items
      .filter((l) => l.productId)
      .map((l) =>
        ddb
          .send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { pk: "PRODUCT", sk: l.productId },
              UpdateExpression: "SET stock = stock - :q",
              ConditionExpression: "attribute_exists(pk) AND attribute_type(stock, :n)",
              ExpressionAttributeValues: { ":q": l.qty, ":n": "N" },
            })
          )
          .catch(() => {}) // product may be untracked (stock null) or deleted
      )
  );

  return json(201, { sale: stripKeys(sale) });
}

async function listSales(query) {
  const date = query?.date; // optional YYYY-MM-DD
  const items = await listByPartition("SALE", {
    forward: false,
    limit: date ? 500 : 100,
    beginsWith: date || undefined,
  });
  return json(200, { sales: items.map(stripKeys) });
}

async function dailyReport(query) {
  const date = query?.date || new Date().toISOString().slice(0, 10);
  const sales = await listByPartition("SALE", { beginsWith: date, limit: 1000 });
  const total = sales.reduce((s, x) => s + (x.total || 0), 0);
  const count = sales.length;
  const byPayment = {};
  for (const s of sales) {
    byPayment[s.payment] = (byPayment[s.payment] || 0) + (s.total || 0);
  }
  return json(200, {
    date,
    count,
    total: Math.round(total * 100) / 100,
    byPayment,
  });
}

// Remove the internal pk/sk before returning items to the client.
function stripKeys(item) {
  const { pk, sk, password, ...rest } = item;
  return rest;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

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
    // Public routes
    if (path === "/api/login" && method === "POST") return await handleLogin(body);
    if (path === "/" || path === "/health") return json(200, { ok: true, service: "posmp" });

    // Everything below requires a valid token.
    const auth = requireAuth(event);
    if (!auth) return json(401, { error: "unauthorized" });

    if (path === "/api/products" && method === "GET") return await listProducts();
    if (path === "/api/products" && method === "POST") return await saveProduct(body);

    const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch) {
      const id = decodeURIComponent(productMatch[1]);
      if (method === "PUT") return await saveProduct(body, id);
      if (method === "DELETE") return await deleteProduct(id);
    }

    if (path === "/api/sales" && method === "POST") return await recordSale(body, auth.sub);
    if (path === "/api/sales" && method === "GET") return await listSales(query);
    if (path === "/api/reports/daily" && method === "GET") return await dailyReport(query);

    return json(404, { error: "not found", path });
  } catch (err) {
    console.error("handler error", err);
    return json(500, { error: "internal error" });
  }
};
