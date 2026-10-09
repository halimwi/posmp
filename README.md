# posmp — low-cost retail management for a small shop

A minimal, self-hostable retail app for a single shop: point of sale, inventory
with cost of goods, and sales/profit reports. Prices are in Indonesian Rupiah
(IDR). It runs almost entirely inside the AWS free tier, and after the free tier
a low-volume shop should pay roughly **$1–3/month**.

- **Register** — scan a barcode or tap products, discount, cash/card/QRIS/transfer,
  change calculation, printable receipt.
- **Products** — SKU/barcode, category, cost of goods and selling price with margin,
  CSV import/export.
- **Inventory** — receive stock (updates cost as a weighted average), stock counts,
  damaged/lost and other adjustments with a full movement log, low-stock alerts,
  stock value at cost and at price.
- **Refunds** — refund some or all items of a sale, optionally back into stock.
- **Reports** — today / yesterday / 7 days / month / custom range: net sales, gross
  profit and margin, cost of goods sold, discounts, refunds, payment types, daily
  breakdown, best sellers, categories, CSV export.
- **Users** — managers add operators and other managers, reset passwords, deactivate.

## Roles

| | Manager | Operator |
|---|---|---|
| Record sales at the register | ✓ | ✓ |
| See own sales for today, reprint receipts | ✓ | ✓ |
| See cost of goods | ✓ | — |
| Add/edit products, prices, cost of goods, CSV import | ✓ | — |
| Receive stock and adjust inventory | ✓ | — |
| Refunds | ✓ | — |
| Reports and sales export | ✓ | — |
| Manage users | ✓ | — |

Roles are enforced by the API, not just hidden in the UI. Sale prices and costs
are read from the product records on the server, so the register cannot be used
to change a price. Role changes and deactivations take effect on the next request.

## Architecture

```
 Browser ──HTTPS──► CloudFront ──► S3 (private)      static site: HTML/CSS/JS
    │
    └────HTTPS──► Lambda Function URL ──► Lambda ──► DynamoDB    API + data
```

| Layer | Service | Why |
|-------|---------|-----|
| Static site | **S3 (private) + CloudFront** | Pennies of storage; CloudFront adds HTTPS and 1 TB/mo free egress. |
| API | **Lambda + Function URL** | No API Gateway, so no per-request gateway bill. Lambda's 1M free requests/mo covers a small shop. |
| Database | **DynamoDB on-demand** | Pay-per-request, 25 GB free. No always-on cost like RDS (~$12+/mo). Point-in-time recovery on (~$0.20/GB-month). |
| Auth | **JWT signed in Lambda** | No Cognito needed for a few users. Passwords hashed with PBKDF2. |
| Compute arch | **arm64 (Graviton)** | Cheaper per-ms than x86. |

### Why not API Gateway?

The most common "serverless" bill-surprise is API Gateway. A **Lambda Function
URL** gives the same public HTTPS endpoint for free, which is all a single-shop
app needs. If you later want a custom domain, WAF, or usage plans, you can put
CloudFront (or API Gateway) in front without changing the app.

### Rough monthly cost (low-volume shop, after free tier)

| Service | Assumption | Cost |
|---------|-----------|------|
| Lambda | ~30k requests | ~$0.00 (within free tier basically forever) |
| DynamoDB | on-demand, tiny | ~$0.01–$0.25 |
| S3 | a few MB | ~$0.01 |
| CloudFront | low traffic | ~$0.50–$1.50 |
| **Total** | | **~$1/month** |

DynamoDB and Lambda have a *perpetual* free tier; S3 and CloudFront free tiers
last the first 12 months.

## Repository layout

```
backend/
  index.mjs          Single Lambda: auth, users, products, stock, sales, refunds, reports (zero npm deps)
  package.json
frontend/
  index.html         Vanilla-JS single-page app (no build step)
  app.js
  styles.css
  config.example.js  Template for the generated config.js
template.yaml        AWS SAM: DynamoDB + Lambda(+URL) + S3 + CloudFront
deploy.sh            Build, deploy, wire the frontend, upload the site
dev/                 Local server + in-memory DynamoDB for development
test/                API tests (node --test) against the real handler
```

## Deploy

You need the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
(run `aws configure`) and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).

```bash
./deploy.sh
```

It deploys to **Singapore (`ap-southeast-1`)** by default; set `REGION=...` to change it.
The first run is guided — SAM will ask for a stack name and these values:

- **AdminPassword** — the initial password for the `admin` manager (min 8 chars).
- **ShopName** — shown on the sign-in screen and receipts (default `Jaya Mandiri`).
- **ShopTzOffsetMinutes** — the shop's time zone for daily reports (default `420`, WIB).
- **JwtSecret** — any long random string used to sign sessions. Generate one with:
  ```bash
  openssl rand -hex 32
  ```

When it finishes it prints your live URL (a `*.cloudfront.net` address). Open
it, sign in as `admin`, change the password (click your name in the top bar),
add your products, then add an operator account under **Users**.

Re-running `./deploy.sh` later picks up your saved settings, redeploys code, and
re-uploads the site.

### Manual deploy (without deploy.sh)

```bash
sam build
sam deploy --guided                     # provisions everything
# grab outputs:
aws cloudformation describe-stacks --stack-name posmp \
  --query "Stacks[0].Outputs" --output table
# put ApiUrl into frontend/config.js, then:
aws s3 sync frontend/ s3://<SiteBucketName>/ --delete --exclude config.example.js
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
```

## Local development

Runs the frontend and the real Lambda handler on one port, backed by an
in-memory DynamoDB (data is lost when it stops). Needs Node 20+.

```bash
npm install
npm run dev        # http://localhost:8080, sign in as admin / localpass123
npm test           # API tests
```

## Data model (DynamoDB single table)

One table, partitioned by record type so every list is a single `Query`:

| Record | `pk` | `sk` |
|--------|------|------|
| User | `USER` | `<username>` |
| Product | `PRODUCT` | `<productId>` |
| Sale | `SALE` | `<ISO-timestamp>#<saleId>` |
| Refund | `REFUND` | `<ISO-timestamp>#<refundId>` |
| Stock movement | `MOVE` | `<ISO-timestamp>#<moveId>` |

Sales, refunds and stock movements sort chronologically by `sk`, so any date
range is a plain range query with no secondary index. Each sale line keeps the
price and cost of goods at the time of sale, so later price changes don't
rewrite past profit.

Money is stored as whole Rupiah. Day boundaries for reports use the shop's
time zone (`SHOP_TZ_OFFSET_MINUTES`), not UTC.

### Upgrading an existing deployment

Older `admin` users become managers and `cashier` users become operators
automatically. Products created before this version have no cost of goods
(Rp 0) until a manager sets it, so their profit will read as 100% margin.

## Security notes

- The Function URL is public (`AuthType: NONE`); the **app** enforces auth with
  a JWT on every route except `/api/login`. Passwords are PBKDF2-hashed.
- Set a strong `JwtSecret` and change the admin password after first login.
- Rotating `JwtSecret` (redeploy) invalidates all existing sessions.
- For a production shop, consider adding CloudFront in front of the Function URL
  and a WAF rate-limit rule; both are optional and omitted here to keep costs at
  the floor.

## Extending

- **More shops:** add a `storeId` to products, stock and sales, and a store picker.
- **Suppliers and purchase orders:** a `SUPPLIER` partition and receiving against a PO.
- **Payments:** QRIS or card terminal integration on the register.
