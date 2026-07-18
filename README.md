# posmp — a low-cost Point of Sale for a small shop

A minimal, self-hostable POS for a mom-and-pop store. It runs almost entirely
inside the AWS free tier, and after the free tier a low-volume shop should pay
roughly **$0.50–$2/month**.

- **Register** — tap products into a cart, pick a payment type, charge.
- **Products** — add/edit/delete items, optional stock tracking (auto-decrements on sale).
- **Reports** — today's totals by payment type, plus recent transactions.
- Single owner/cashier login to start; add more users later.

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
| Database | **DynamoDB on-demand** | Pay-per-request, 25 GB free. No always-on cost like RDS (~$12+/mo). |
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
  index.mjs          Single Lambda: auth, products, sales, reports (zero npm deps)
  package.json
frontend/
  index.html         Vanilla-JS single-page app (no build step)
  app.js
  styles.css
  config.example.js  Template for the generated config.js
template.yaml        AWS SAM: DynamoDB + Lambda(+URL) + S3 + CloudFront
deploy.sh            Build, deploy, wire the frontend, upload the site
```

## Deploy

You need the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
(run `aws configure`) and the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).

```bash
./deploy.sh
```

The first run is guided — SAM will ask for a stack name and two values:

- **AdminPassword** — the initial password for the `admin` user (min 8 chars).
- **JwtSecret** — any long random string used to sign sessions. Generate one with:
  ```bash
  openssl rand -hex 32
  ```

When it finishes it prints your live URL (a `*.cloudfront.net` address). Open
it, sign in as `admin`, and start adding products.

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

The frontend is static, so any static server works:

```bash
cd frontend && python3 -m http.server 8080
```

Open <http://localhost:8080>. On the login screen enter your deployed **API URL**
(the `ApiUrl` output) — it's saved in the browser. The backend has no local
emulator here; point local dev at the deployed Lambda, or use `sam local
start-lambda` if you want to run it offline.

## Data model (DynamoDB single table)

One table, partitioned by record type so every list is a single `Query`:

| Record | `pk` | `sk` |
|--------|------|------|
| User | `USER` | `<username>` |
| Product | `PRODUCT` | `<productId>` |
| Sale | `SALE` | `<ISO-timestamp>#<saleId>` |

Sales sort chronologically by `sk`, so "recent sales" and "today's total" are
plain range queries with no secondary index.

## Security notes

- The Function URL is public (`AuthType: NONE`); the **app** enforces auth with
  a JWT on every route except `/api/login`. Passwords are PBKDF2-hashed.
- Set a strong `JwtSecret` and change the admin password after first login.
- Rotating `JwtSecret` (redeploy) invalidates all existing sessions.
- For a production shop, consider adding CloudFront in front of the Function URL
  and a WAF rate-limit rule; both are optional and omitted here to keep costs at
  the floor.

## Extending

- **More cashiers:** add `USER` items (a small admin screen or a one-off script).
- **Receipts:** the sale record has everything needed to render/print a receipt.
- **CSV export:** query the `SALE` partition by date range.
- **Barcode scanning:** most USB/Bluetooth scanners act as a keyboard — wire the
  input to the product `sku` lookup.
