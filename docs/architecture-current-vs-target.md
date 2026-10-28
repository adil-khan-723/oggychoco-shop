# Shop: current architecture vs target architecture

Date: 2026-10-28
Site: https://oggychoco.website (AWS region ap-south-1, Mumbai)

This compares what is running today with the target in the diagram "Proposed AWS Architecture - Horizontally Scaled Web Application". It lists the gaps, the code changes needed, the risks, and the decisions still open. It is meant to be read without any other context.

---

## 1. Current architecture (what is running today)

```
Users --HTTPS--> oggychoco.website (DNS A record -> 3.110.239.142)
                        |
                 [ EC2 t3.micro, public subnet, public IP ]
                   Nginx :443 (Let's Encrypt cert, certbot)
                     -> Node 20 / Express / EJS  :3000  (pm2, 1 process)
                     -> MySQL 8 on the same machine (localhost)
                   sessions in process memory, uploads on local disk
```

| Area | Current state |
|---|---|
| Compute | One `t3.micro` (2 vCPU, 908 MB RAM, 2 GB swap file), Ubuntu 26.04, instance `i-037f44b92e4803fa2` |
| App | Node 20, Express, EJS, `mysql2`; run by pm2 as one process (`fork` mode, restart at 300 MB) |
| Web server / TLS | Nginx reverse proxy on the same machine, Let's Encrypt certificate via certbot, HTTP redirects to HTTPS |
| Database | MySQL 8 on the same machine. The app reads `DB_HOST`, `DB_USER`, `DB_PASSWORD` etc. from environment variables or a `.env` file (defaults to `localhost`) |
| Sessions | Stored in the MySQL `sessions` table (`express-mysql-session`), so they survive restarts and can be shared by several servers. Secret comes from `SESSION_SECRET` in `.env`; 24-hour cookie |
| File uploads | Product images are written to `public/uploads` on local disk. An S3 mode exists (`UPLOADS_BUCKET`) but is not enabled yet |
| Health checks | `GET /health` (cheap) and `GET /health/db` (also checks the database) |
| Access | SSH with a key pair |
| Backups | None configured by the project (only manual `mysqldump` files taken during cleanups) |
| Monitoring | CloudWatch EC2 metrics at 1-minute resolution, CloudWatch agent (memory, swap, disk) with an IAM role, app `STATS` log line each minute, admin analytics tab (visitors, peak concurrent users, buyers) |
| DNS | GoDaddy-registered domain, A record to the instance public IP |
| Deploy | `deploy.sh` installs everything on one machine (Node, MySQL, pm2, Nginx, certbot) and runs 64 smoke checks |

### Measured capacity today (k6 load test against the live site)

Each simulated shopper loops: home, product list, product page, register, log in, add to cart, checkout page, place order. That is 12 HTTP requests and about 19 seconds per journey, so one user makes about 0.6 requests per second. The test limit was p95 latency under 1.5 s and under 5% failed requests. It is heavier than real traffic (every user registers and buys) but lighter in one way (it does not download CSS or images).

| Version | Result |
|---|---|
| Original code (`bcryptjs`) | Passed at 90 users (p95 0.91 s). At 100 users, p95 was 1.11 s in one run and failed (1.65 s) in an earlier, shorter run. The single Node thread was at about 105% of one core while the second vCPU sat idle |
| After switching to native `bcrypt` | Passed every step up to **200 concurrent users**: p95 0.26 s at 100 users, 0.55 s at 200, 0 failed requests out of 55,128. Peak about 120 requests/s. **The ceiling was not found** (the test stopped at 200) |

Other measurements: CPU credits were not exhausted; MySQL used about 7% CPU and Nginx about 2.5% at 100 users; memory is tight (516 MB of swap in use after the build).

This is the baseline to compare the new architecture against. The same `loadtest/shopper.js` can be run against the new load balancer.

---

## 2. Target architecture (from the diagram)

```
Users --HTTPS--> GoDaddy DNS: www CNAME -> ALB DNS name (root domain forwarded to www)
                        |
                 Internet Gateway
                        |
   VPC 10.0.0.0/16, region ap-south-1
   +-- Public subnets (1a 10.0.1.0/24, 1b 10.0.2.0/24)
   |     Application Load Balancer: HTTPS 443 (ACM certificate), HTTP 80 -> 443,
   |       health checks, sticky sessions
   |     NAT gateway in each AZ (outbound only: updates, packages)
   +-- Private app subnets (1a 10.0.11.0/24, 1b 10.0.12.0/24)
   |     App server 1 (1a) and App server 2 (1b): EC2 t3.micro, no public IP,
   |       App security group: allow only from the ALB, EC2 role for SSM access
   +-- Private DB subnet (1a 10.0.21.0/24)
         DB server: EC2 running MySQL or PostgreSQL, no public IP,
           DB security group: port 3306/5432 only from the App security group
           daily backup, cron 02:30 IST -> S3 via S3 gateway endpoint
   Also: ACM certificate (DNS-validated through GoDaddy), CloudWatch (metrics and alarms),
         Systems Manager Session Manager (no SSH open to the internet),
         S3 bucket "db-backups" (compressed, encrypted, public access blocked, delete after 14 days)
```

---

## 3. Gap analysis

| Area | Current | Target | Work needed |
|---|---|---|---|
| Entry point / TLS | Nginx and Let's Encrypt on the server | ALB with an ACM certificate | Create ALB, target group, listeners; request ACM certificate; remove Nginx and certbot from the app servers |
| Compute | 1 server | 2 servers in 2 AZs | Launch two app servers from the same build; no public IPs |
| Network | Public subnet only | VPC with public, app and DB subnets, NAT, IGW, 3 security groups | Build the whole network |
| Database | Same machine | Separate private DB server | Move MySQL out, restore the data, point the app to it |
| Sessions | In memory | Sticky sessions on the ALB | See section 4 (a shared store is the better fix) |
| Uploads | Local disk | Not covered in the diagram | Must move to shared storage (section 4) |
| Admin access | SSH key | SSM Session Manager | Add SSM role to each instance; close SSH |
| Backups | None | Daily to S3, 14-day retention | Write the backup script, cron job, bucket, lifecycle rule |
| Monitoring | Basic metrics, agent, analytics tab | CloudWatch metrics and alarms | Create alarms (CPU, status checks, ALB 5xx, unhealthy hosts, disk, memory) |
| DNS | A record to an IP | `www` CNAME to the ALB, root forwarded to `www` | Change at GoDaddy at cutover; add the ACM validation CNAME |
| Deploy | One script for everything | Per-role setup | Split `deploy.sh` (section 4) |

---

## 4. Application changes required (the app will not work on two servers as it is)

| # | Change | Why | Size |
|---|---|---|---|
| 1 | Read DB host, user and password from environment variables (`db.js`) | It is hard-coded to `localhost` today; the DB moves to its own server. MySQL must also allow connections from the app subnet | Small |
| 2 | Store sessions in MySQL instead of memory | Two servers cannot share memory. Sticky sessions hide the problem but users are still logged out on every deploy, restart or instance failure | Medium |
| 3 | Move product image uploads to S3 (`middleware/upload.js`, image URLs, S3 permission on the instance role) | An image uploaded through one server only exists on that server and will 404 through the other | Medium |
| 4 | Make the admin analytics multi-server safe (`analytics.js`) | "Active visitors" is kept in each process's memory, so peak concurrent users would be undercounted by about half. Fix: keep a `last_seen` time per visitor in the database | Small to medium |
| 5 | Add a lightweight `/health` route | The ALB health check should not render a page and query the database | Small |
| 6 | Move secrets (session secret, DB password) out of the source into SSM Parameter Store or Secrets Manager | They are hard-coded today | Small |
| 7 | Split `deploy.sh` into an app part and a DB part; drop Nginx and certbot | The script currently installs everything on one machine | Medium |
| 8 | Optional: ship `app.log` to CloudWatch Logs | Logs will be on two separate servers | Small |

**Status on 2026-10-28: changes 1-6 are done and live on the current server** (67 of 67 smoke checks pass).
- 1 (DB config) and 6 (secrets): done. `.env` holds a random `SESSION_SECRET`. The DB password still uses the built-in default and should be set when the DB moves.
- 2 (sessions in MySQL): done and tested. A session survived an app restart.
- 3 (uploads to S3): the code is written and tested against a stand-in S3 client only (upload, serve, reject non-images, 404s). It has **not** run against a real bucket, and it stays off until `UPLOADS_BUCKET` is set. When it is on, the `deploy.sh` check that looks for the file on local disk will fail and needs adjusting.
- 4 (analytics across servers): done. "Active now" and peak concurrent users now come from a shared `last_seen` column, so two servers add up correctly.
- 5 (`/health`): done.
- 7 (split `deploy.sh`) and 8 (logs to CloudWatch) are not done; they depend on the final server layout.
- The session store adds two small database queries to each request that has a session. The load test has not been re-run since this change, so capacity should be re-measured.
- The AWS SDK is pinned to `~3.1158.0`: newer releases (from January 2027) will require Node 22, and the app runs Node 20.

Already compatible: `trust proxy` is set to 1, which is correct for one ALB hop, so client IPs in the analytics stay correct. The app listens on plain HTTP on port 3000, which is what the ALB will forward to.

---

## 5. Infrastructure to build

1. VPC, 2 public subnets, 2 private app subnets, 1 private DB subnet, internet gateway, NAT gateway(s), route tables
2. Security groups: ALB (80/443 from the internet), App (port 3000 from the ALB group only), DB (3306 from the App group only)
3. S3 gateway endpoint; S3 buckets (`db-backups` with encryption, public access blocked, 14-day lifecycle; one for uploads)
4. IAM roles: app servers (SSM, CloudWatch agent, uploads bucket), DB server (SSM, write to the backup bucket)
5. ACM certificate for the domain and `*.domain`, validated by a CNAME at GoDaddy
6. ALB: HTTPS 443 with the certificate, HTTP 80 redirecting to HTTPS, target group with the `/health` check
7. 3 EC2 instances (2 app, 1 DB); DB backup cron at **02:30 IST, which is 21:00 UTC the previous day** (the servers run in UTC)
8. CloudWatch alarms; confirm the SSM access works for all three instances
9. Cutover: build it all, restore the DB, test through the ALB DNS name first, lower the DNS TTL, switch the GoDaddy CNAME, keep the old server for a few days, then decommission it

---

## 6. Risks and points to discuss

1. **Cost.** Two NAT gateways and an ALB are billed hourly plus per GB and will likely cost more than everything running today (a rough, unverified estimate is $60-100 a month in total). Check the AWS pricing calculator. Options: one NAT gateway instead of two, or VPC endpoints instead of NAT.
2. **The database is a single point of failure.** It is one EC2 server in one AZ, with backups only once a day (up to 24 hours of data lost). The second AZ protects only the app tier. RDS with Multi-AZ would fix this at extra cost.
3. **DB server size.** The diagram does not say. The app uses MySQL (`mysql2`), so keep MySQL rather than PostgreSQL unless the app is rewritten.
4. **Sticky sessions or a shared session store.** Recommended: a shared store (change 2), then sticky sessions are not needed.
5. **DNS apex.** GoDaddy cannot put a CNAME on the root domain, which is why the diagram forwards the root to `www`. Check that the forwarding handles HTTPS properly, or move DNS to Route 53 and use an alias record on the root.
6. **Operator access changes.** With no SSH, servers are reached through SSM. Anyone (or any tool) operating them needs AWS credentials and the Session Manager plugin.
7. **Capacity expectation.** Two servers should handle roughly twice what one does, if the database keeps up, but that is not measured. The load test should be re-run against the ALB.
8. **"Horizontally scaled" here means two fixed servers.** There is no Auto Scaling group in the diagram. That could be a later step.
9. **Memory on a `t3.micro`.** 1 GB is tight for the app plus the CloudWatch agent, and tighter still for a MySQL server.

---

## 7. Suggested order of work

1. Application changes 1-6 (no AWS access needed; can be tested on the current server)
2. Network, security groups, S3, IAM roles
3. DB server: install MySQL, restore a copy of the data, set up the backup cron and test a restore
4. App servers and the ALB; test through the ALB DNS name
5. ACM certificate and the DNS cutover
6. Alarms, then re-run the k6 load test against the new URL and compare with the baseline in section 1
7. Decommission the old server

## 8. Decisions

Decided on 2026-10-28:
- AWS side is built with Terraform in `infra/`.
- One NAT gateway (revised the same day: the servers need internet for packages and updates). Backups and uploads still go to S3 through the free S3 gateway endpoint, not the NAT. Move to VPC endpoints later (`enable_nat = false`, `enable_ssm_endpoints = true`).
- Database: MySQL on EC2 with backups to S3 first, then a move to RDS to compare the two.
- Shared session store (done), no sticky sessions needed.
- DNS: the domain is at **Namecheap** (not GoDaddy as the diagram says). Keep it there with a `www` CNAME to the ALB; move to Route 53 when a NAT is added.

Still open:
- Whether to add Auto Scaling later
- (Resolved by adding the NAT: the private servers install Node and MySQL through it, so no pre-built AMI is needed.)
