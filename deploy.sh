#!/usr/bin/env bash
#
# One-shot setup + verification for Ubuntu 22.04 / 24.04.
# Run as your normal user (e.g. ubuntu), not root. It uses sudo where needed.
#
#   ./deploy.sh                                              install, start on :3000, run checks
#   DOMAIN=shop.example.com EMAIL=you@example.com ./deploy.sh   also set up Nginx + Let's Encrypt
#   WWW=1 DOMAIN=... EMAIL=... ./deploy.sh                   same, and cover www.<domain> too
#   ./deploy.sh check                                        only run the checks
#   DOMAIN=shop.example.com ./deploy.sh check                also checks https://shop.example.com
#
# Safe to run again: every step skips what is already done.

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

APP_NAME="shop"
BASE="http://127.0.0.1:3000"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
MODE="${1:-deploy}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAILED=0

log()  { printf '\n==> %s\n' "$*"; }
ok()   { PASS=$((PASS + 1));     printf '  [PASS] %s\n' "$*"; }
bad()  { FAILED=$((FAILED + 1)); printf '  [FAIL] %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as a normal user with sudo rights (not root), so pm2 does not run as root." >&2
  exit 1
fi

if [ -n "$DOMAIN" ] && [ -z "$EMAIL" ] && [ "$MODE" != "check" ]; then
  echo "DOMAIN is set but EMAIL is not. Let's Encrypt needs one: EMAIL=you@example.com DOMAIN=$DOMAIN ./deploy.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------- setup steps

setup_swap() {
  local mem_kb
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  if [ "$(swapon --show | wc -l)" -eq 0 ] && [ "$mem_kb" -lt 2000000 ]; then
    log "Adding a 2G swap file (small instance)"
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
}

install_packages() {
  log "Installing system packages"
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates build-essential mysql-server

  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    log "Installing Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  sudo systemctl enable --now mysql
}

setup_database() {
  log "Creating database, user and tables"
  sudo mysql < "$APP_DIR/schema.sql"
}

setup_app() {
  if [ ! -f "$APP_DIR/.env" ]; then
    log "Creating .env with a random session secret (see .env.example for the other settings)"
    printf 'SESSION_SECRET=%s\nANALYTICS_SALT=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" > "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
  fi

  log "Installing npm dependencies"
  mkdir -p "$APP_DIR/logs" "$APP_DIR/public/uploads"
  npm install --omit=dev --no-audit --no-fund

  log "Seeding the database (admin user, categories, products)"
  node seed.js
}

setup_pm2() {
  log "Starting the app with pm2"
  command -v pm2 >/dev/null 2>&1 || sudo npm install -g pm2
  pm2 startOrRestart ecosystem.config.js --update-env
  pm2 save
  sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME" >/dev/null
  pm2 save
}

setup_nginx() {
  [ -z "$DOMAIN" ] && return 0
  log "Setting up Nginx and HTTPS for $DOMAIN"
  sudo apt-get install -y nginx certbot python3-certbot-nginx

  local names="$DOMAIN" certbot_names=(-d "$DOMAIN")
  if [ "${WWW:-0}" = "1" ]; then
    names="$DOMAIN www.$DOMAIN"
    certbot_names=(-d "$DOMAIN" -d "www.$DOMAIN")
  fi

  local conf="/etc/nginx/sites-available/$APP_NAME"
  if [ ! -f "$conf" ]; then
    sudo tee "$conf" >/dev/null <<'EOF'
server {
    listen 80;
    server_name __DOMAIN__;

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
EOF
    sudo sed -i "s/__DOMAIN__/$names/g" "$conf"
  fi
  sudo ln -sf "$conf" "/etc/nginx/sites-enabled/$APP_NAME"
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl enable --now nginx
  sudo systemctl reload nginx

  sudo certbot --nginx "${certbot_names[@]}" -m "$EMAIL" --agree-tos --no-eff-email \
    --non-interactive --redirect --keep-until-expiring
  sudo nginx -t
  sudo systemctl reload nginx
}

# --------------------------------------------------------------------- checks

# expect <label> <wanted status> <curl args...>   (response body lands in $TMP/body)
expect() {
  local label="$1" want="$2" got
  shift 2
  got="$(curl -s -o "$TMP/body" -w '%{http_code}' "$@" || true)"
  if [ "$got" = "$want" ]; then ok "$label ($got)"; else bad "$label (wanted $want, got $got)"; fi
}

# body_has <label> <text>   /   body_lacks <label> <text>
body_has()   { if grep -q -- "$2" "$TMP/body"; then ok "$1"; else bad "$1 (missing \"$2\")"; fi; }
body_lacks() { if grep -q -- "$2" "$TMP/body"; then bad "$1 (found \"$2\")"; else ok "$1"; fi; }

db() { sudo mysql shop -N -e "$1"; }

run_checks() {
  log "Running checks"
  local stamp email user_jar admin_jar i up=0
  stamp="$(date +%s)"
  email="smoke-$stamp@check.local"
  user_jar="$TMP/user.jar"
  admin_jar="$TMP/admin.jar"

  echo "-- process and database"
  if pm2 describe "$APP_NAME" 2>/dev/null | grep -q 'online'; then ok "pm2 process '$APP_NAME' is online"; else bad "pm2 process '$APP_NAME' is not online"; fi
  if systemctl is-active --quiet mysql; then ok "mysql service is running"; else bad "mysql service is not running"; fi
  if [ "$(MYSQL_PWD=shoppass123 mysql -ushop shop -N -e 'SELECT COUNT(*) FROM products' 2>/dev/null || echo 0)" -ge 20 ]; then
    ok "app DB user can connect and products are seeded"
  else
    bad "app DB user cannot connect or products are missing"
  fi

  echo "-- waiting for the app on :3000"
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "$BASE/"; then up=1; break; fi
    sleep 1
  done
  if [ "$up" -eq 1 ]; then ok "app answers on port 3000"; else bad "app did not answer within 30s (see: pm2 logs $APP_NAME)"; return; fi

  echo "-- health checks"
  expect "health check" 200 "$BASE/health";               body_has "health says ok" "ok"
  expect "database health check" 200 "$BASE/health/db"

  echo "-- public pages"
  expect "home page" 200 "$BASE/";                        body_has "home shows featured products" "Featured products"
  expect "product list" 200 "$BASE/products";             body_has "list shows seeded product" "Wireless Earbuds"
  expect "product detail" 200 "$BASE/products/1";         body_has "detail has add to cart" "Add to cart"
  expect "search" 200 "$BASE/products?q=speaker";         body_has "search finds Bluetooth Speaker" "Bluetooth Speaker"; body_lacks "search filters others out" "Wireless Earbuds"
  expect "category filter" 200 "$BASE/products?category=books"; body_has "category shows Garden Notes" "Garden Notes"; body_lacks "category hides electronics" "Wireless Earbuds"
  expect "SQL-ish search input is harmless" 200 -G --data-urlencode "q=' OR 1=1 --" "$BASE/products"; body_has "no products matched injection string" "No products found"
  expect "unknown product" 404 "$BASE/products/99999"
  expect "unknown page" 404 "$BASE/nope"
  expect "login page" 200 "$BASE/login"
  expect "register page" 200 "$BASE/register"
  expect "static css" 200 "$BASE/css/style.css"
  expect "product image" 200 "$BASE/images/products/p1.svg"

  echo "-- shopper flow (register, login, cart, checkout)"
  expect "register" 200 -L -c "$user_jar" -b "$user_jar" --data-urlencode "name=Smoke Test" --data-urlencode "email=$email" --data-urlencode "password=Passw0rd!123" "$BASE/register"
  body_has "logged in after register" "Logout"
  expect "duplicate register rejected" 400 --data-urlencode "name=Smoke Test" --data-urlencode "email=$email" --data-urlencode "password=Passw0rd!123" "$BASE/register"
  expect "logout" 200 -L -c "$user_jar" -b "$user_jar" -d "" "$BASE/logout"
  expect "wrong password rejected" 401 -c "$user_jar" -b "$user_jar" --data-urlencode "email=$email" --data-urlencode "password=wrong-password" "$BASE/login"
  expect "login" 200 -L -c "$user_jar" -b "$user_jar" --data-urlencode "email=$email" --data-urlencode "password=Passw0rd!123" "$BASE/login"
  body_has "logged in after login" "Hi, Smoke Test"
  expect "add to cart" 200 -L -c "$user_jar" -b "$user_jar" -d "productId=3&quantity=2" "$BASE/cart/add"
  body_has "cart lists Smart Watch" "Smart Watch"
  expect "update cart quantity" 200 -L -c "$user_jar" -b "$user_jar" -d "productId=3&quantity=1" "$BASE/cart/update"
  expect "checkout page" 200 -c "$user_jar" -b "$user_jar" "$BASE/checkout"
  expect "place order" 200 -L -c "$user_jar" -b "$user_jar" \
    --data-urlencode "name=Smoke Test" --data-urlencode "email=$email" --data-urlencode "address=1 Test Street" \
    --data-urlencode "city=Testville" --data-urlencode "postal_code=12345" "$BASE/checkout"
  body_has "order confirmation shown" "Thank you for your order"
  expect "cart empty after order" 200 -c "$user_jar" -b "$user_jar" "$BASE/cart"
  body_has "cart is empty" "Your cart is empty"
  if [ "$(db "SELECT COUNT(*) FROM orders WHERE email='$email' AND status='paid'")" = "1" ]; then ok "order saved in DB as paid"; else bad "order missing in DB"; fi
  if [ "$(db "SELECT password_hash LIKE '\$2%' FROM users WHERE email='$email'")" = "1" ]; then ok "password stored as bcrypt hash"; else bad "password is not a bcrypt hash"; fi

  echo "-- admin"
  expect "admin area redirects when logged out" 302 "$BASE/admin/products"
  expect "admin area forbidden for customers" 403 -c "$user_jar" -b "$user_jar" "$BASE/admin/products"
  expect "analytics forbidden for customers" 403 -c "$user_jar" -b "$user_jar" "$BASE/admin/analytics"
  expect "admin login" 200 -L -c "$admin_jar" -b "$admin_jar" --data-urlencode "email=admin" --data-urlencode "password=admin" "$BASE/login"
  expect "admin product list" 200 -c "$admin_jar" -b "$admin_jar" "$BASE/admin/products"
  body_has "admin list rendered" "Manage products"
  expect "admin analytics page" 200 -c "$admin_jar" -b "$admin_jar" "$BASE/admin/analytics"
  body_has "analytics shows visitors" "Visitors today"
  body_has "analytics shows peak concurrent users" "Peak concurrent users"
  expect "admin analytics for a past day" 200 -c "$admin_jar" -b "$admin_jar" "$BASE/admin/analytics?day=2020-01-15"
  expect "admin new product form" 200 -c "$admin_jar" -b "$admin_jar" "$BASE/admin/products/new"
  expect "admin edit product form" 200 -c "$admin_jar" -b "$admin_jar" "$BASE/admin/products/1/edit"

  # 1x1 PNG
  printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' | base64 -d > "$TMP/pixel.png"
  echo "not an image" > "$TMP/notes.txt"

  expect "admin product create with image upload" 302 -c "$admin_jar" -b "$admin_jar" \
    -F "name=Smoke test product" -F "category_id=1" -F "price=1.00" -F "description=temp" -F "image=@$TMP/pixel.png;type=image/png" "$BASE/admin/products"
  local img
  img="$(db "SELECT image FROM products WHERE name='Smoke test product' ORDER BY id DESC LIMIT 1")"
  if [ -n "$img" ] && [ -f "$APP_DIR/public$img" ]; then ok "uploaded file written to public/uploads ($img)"; else bad "uploaded file not found on disk ($img)"; fi
  if [ -n "$img" ]; then expect "uploaded image is served" 200 "$BASE$img"; fi
  expect "non-image upload rejected" 400 -c "$admin_jar" -b "$admin_jar" \
    -F "name=Smoke bad upload" -F "category_id=1" -F "price=1.00" -F "image=@$TMP/notes.txt;type=text/plain" "$BASE/admin/products"

  echo "-- logging and scheduled job"
  if [ -s "$APP_DIR/logs/app.log" ]; then ok "logs/app.log is being written"; else bad "logs/app.log is empty or missing"; fi
  if grep -q 'scheduled jobs started' "$APP_DIR/logs/app.log" 2>/dev/null; then ok "nightly cron job registered"; else bad "no 'scheduled jobs started' line in app.log"; fi

  if [ -n "$DOMAIN" ]; then
    echo "-- nginx and https ($DOMAIN)"
    if sudo nginx -t >/dev/null 2>&1; then ok "nginx config is valid"; else bad "nginx config is invalid"; fi
    expect "http redirects to https" 301 "http://$DOMAIN/"
    expect "https home page" 200 "https://$DOMAIN/"
    body_has "https serves the app" "Featured products"
    expect "https product image" 200 "https://$DOMAIN/images/products/p1.svg"
  fi

  echo "-- cleaning up test data"
  db "DELETE FROM orders WHERE email LIKE 'smoke-%@check.local'"
  db "DELETE FROM users WHERE email LIKE 'smoke-%@check.local'"
  db "DELETE FROM products WHERE name='Smoke test product'"
  if [ -n "$img" ]; then rm -f "$APP_DIR/public$img"; fi

  printf '\nChecks: %d passed, %d failed\n' "$PASS" "$FAILED"
  [ "$FAILED" -eq 0 ]
}

# ----------------------------------------------------------------------- main

if [ "$MODE" = "check" ]; then
  run_checks
  exit $?
fi

setup_swap
install_packages
setup_database
setup_app
setup_pm2
setup_nginx

if run_checks; then
  log "All done"
  if [ -n "$DOMAIN" ]; then echo "Site: https://$DOMAIN"; else echo "App: http://<server-ip>:3000 (open the port, or pass DOMAIN and EMAIL to set up Nginx + HTTPS)"; fi
  echo "Admin login: admin / admin"
else
  log "Setup finished but some checks failed. Look at the [FAIL] lines above and: pm2 logs $APP_NAME"
  exit 1
fi
