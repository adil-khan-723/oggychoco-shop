# Shop

Small e-commerce site: Node.js 20, Express, EJS, MySQL 8. Runs on one Ubuntu 22.04/24.04 server behind Nginx.

## Quick start (does everything below in one go)

Copy the project to the server, then as a normal sudo user (e.g. `ubuntu`):

```bash
chmod +x deploy.sh
./deploy.sh                                                  # app on port 3000
EMAIL=you@example.com DOMAIN=shop.example.com ./deploy.sh    # plus Nginx and HTTPS
./deploy.sh check                                            # re-run the checks only
```

It installs Node 20, MySQL, pm2 (and Nginx/certbot when `DOMAIN` is set), loads `schema.sql`, seeds the data, starts the app, and finishes by testing every page and the shopper/admin flows. The manual steps are below.

## Install

### Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### MySQL 8

```bash
sudo apt update
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
```

### Database

From the project folder:

```bash
sudo mysql < schema.sql
```

This creates the `shop` database, the `shop` MySQL user and all tables.

### App

```bash
npm install
npm run seed      # admin user, 4 categories, 20 products
```

Admin login after seeding: `admin` / `admin` (test site only, change it before real use)

## Configuration (.env)

Settings are read from environment variables, or from a `.env` file next to `app.js` (see `.env.example`). Every value is optional and the defaults match a single-server install; `deploy.sh` creates `.env` with a random session secret.

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Database connection. Set `DB_HOST` when MySQL is on another server |
| `SESSION_SECRET` | Signs the session cookie. Use the same value on every app server |
| `ANALYTICS_SALT` | Salt for the hashed visitor ids in the analytics tab. Same on every app server |
| `UPLOADS_BUCKET`, `AWS_REGION` | Store product images in S3 instead of `public/uploads`. The instance role needs `s3:PutObject` and `s3:GetObject` on the bucket |

Because sessions are stored in MySQL (the `sessions` table) and analytics use the shared database, several app servers can run side by side. `GET /health` is a cheap check for a load balancer and `GET /health/db` also checks the database.

## Run with pm2

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints
```

The app listens on port 3000. Logs go to `logs/app.log` (also `pm2 logs shop`).

## Nginx + HTTPS (Let's Encrypt)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/shop` (replace `shop.example.com`), link it into `sites-enabled`, remove the default site, then `sudo nginx -t && sudo systemctl reload nginx`.
Get the certificate with `sudo certbot --nginx -d shop.example.com`.

```nginx
server {
    listen 80;
    server_name shop.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Load test (k6)

Install k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/), then run it from your own machine:

```bash
BASE_URL=https://shop.example.com k6 run loadtest/shopper.js
```

The test climbs in steps (default 50, 100, 200, 300, 500, 750, 1000 users, each held for 90 seconds). Each step has its own p95 latency, error rate and check thresholds, and the first step to fail stops the run. The last step that passed is the number of concurrent users the app handled. Edit the `STEPS` array at the top of `loadtest/shopper.js` to change the ladder.
