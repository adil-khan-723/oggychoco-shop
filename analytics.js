const crypto = require('crypto');
const db = require('./db');
const logger = require('./logger');

const SALT = process.env.ANALYTICS_SALT || 'shop-analytics';
const ACTIVE_WINDOW_MINUTES = 5;
const WRITE_EVERY_MS = 60 * 1000;
const BUCKET_MINUTES = 5;
// load-test traffic (k6) and its fake orders are kept out of the numbers
const NOT_TEST_ORDER = " AND email NOT LIKE '%@loadtest.local'";

// visitor -> when this server last wrote their last_seen, so a busy visitor costs one write a minute
const lastWrite = new Map();
let writtenDay = '';
let pageViews = 0;

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function dayOf(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function minuteOf(d) {
  return dayOf(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
}

function today() {
  return dayOf(new Date());
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n));
}

// returns the day if it is a real date in YYYY-MM-DD form, otherwise today
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return today();
  const [y, m, d] = value.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d)) === value ? value : today();
}

function visitorId(day, ip) {
  return crypto.createHash('sha256').update(SALT + day + ip).digest('hex').slice(0, 16);
}

// visitors seen by any app server in the last 5 minutes (last_seen is kept in the shared database)
async function activeNow(day) {
  const [[row]] = await db.execute(
    'SELECT COUNT(*) AS n FROM analytics_visitors WHERE day = ? AND last_seen >= NOW() - INTERVAL ' + ACTIVE_WINDOW_MINUTES + ' MINUTE',
    [day]
  );
  return row.n;
}

// runs after express.static, so it only sees pages, not css/images; the admin's own pages are not counted
function middleware(req, res, next) {
  if (req.path.startsWith('/admin')) return next();
  if ((req.get('user-agent') || '').startsWith('k6/')) return next();
  const day = today();
  const visitor = visitorId(day, req.ip);
  const now = Date.now();
  pageViews++;
  if (day !== writtenDay) {
    writtenDay = day;
    lastWrite.clear();
  }
  if (now - (lastWrite.get(visitor) || 0) >= WRITE_EVERY_MS) {
    lastWrite.set(visitor, now);
    db.execute(
      'INSERT INTO analytics_visitors (day, visitor, last_seen) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE last_seen = NOW()',
      [day, visitor]
    ).catch((err) => {
      logger.error('analytics visitor write failed: ' + err.message);
    });
  }
  next();
}

// every app server adds its own page views to the minute's row; the active count is the same for all of them
async function flush() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [visitor, t] of lastWrite) {
    if (t < cutoff) lastWrite.delete(visitor);
  }
  let views = 0;
  try {
    const active = await activeNow(today());
    if (pageViews === 0 && active === 0) return;
    views = pageViews;
    pageViews = 0;
    await db.execute(
      'INSERT INTO analytics_minutes (minute, page_views, active_visitors) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE page_views = page_views + VALUES(page_views), ' +
      'active_visitors = GREATEST(active_visitors, VALUES(active_visitors))',
      [minuteOf(new Date()), views, active]
    );
  } catch (err) {
    pageViews += views;
    logger.error('analytics flush failed: ' + err.message);
  }
}

function start() {
  setInterval(flush, 60 * 1000).unref();
}

async function report(day) {
  const next = addDays(day, 1);
  const isToday = day === today();

  const [[visitors]] = await db.execute('SELECT COUNT(*) AS n FROM analytics_visitors WHERE day = ?', [day]);

  const [peakRows] = await db.execute(
    "SELECT active_visitors AS n, DATE_FORMAT(minute, '%H:%i') AS at FROM analytics_minutes " +
    'WHERE minute >= ? AND minute < ? ORDER BY active_visitors DESC, minute ASC LIMIT 1',
    [day, next]
  );

  const [[bought]] = await db.execute(
    'SELECT COUNT(DISTINCT email) AS buyers, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue FROM orders ' +
    "WHERE status = 'paid' AND created_at >= ? AND created_at < ?" + NOT_TEST_ORDER,
    [day, next]
  );

  // active visitors per 5 minutes, midnight up to now (or the whole day for past days)
  const [rows] = await db.execute(
    'SELECT FLOOR((HOUR(minute) * 60 + MINUTE(minute)) / ' + BUCKET_MINUTES + ') AS b, ' +
    'MAX(active_visitors) AS active, SUM(page_views) AS views ' +
    'FROM analytics_minutes WHERE minute >= ? AND minute < ? GROUP BY b',
    [day, next]
  );
  const now = new Date();
  const count = isToday ? Math.floor((now.getHours() * 60 + now.getMinutes()) / BUCKET_MINUTES) + 1 : (24 * 60) / BUCKET_MINUTES;
  const buckets = [];
  for (let i = 0; i < count; i++) {
    const mins = i * BUCKET_MINUTES;
    buckets.push({ label: pad(Math.floor(mins / 60)) + ':' + pad(mins % 60), active: 0, views: 0, peak: false });
  }
  let max = 0;
  rows.forEach((r) => {
    if (buckets[r.b]) {
      buckets[r.b].active = r.active;
      buckets[r.b].views = r.views;
      if (r.active > max) max = r.active;
    }
  });
  const peakBucket = buckets.find((b) => max > 0 && b.active === max);
  if (peakBucket) peakBucket.peak = true;

  // last 14 days, newest first
  const from = addDays(today(), -13);
  const [visitorDays] = await db.execute(
    "SELECT DATE_FORMAT(day, '%Y-%m-%d') AS d, COUNT(*) AS visitors FROM analytics_visitors WHERE day >= ? GROUP BY d",
    [from]
  );
  const [minuteDays] = await db.execute(
    "SELECT DATE_FORMAT(minute, '%Y-%m-%d') AS d, MAX(active_visitors) AS peak, SUM(page_views) AS views " +
    'FROM analytics_minutes WHERE minute >= ? GROUP BY d',
    [from]
  );
  const [orderDays] = await db.execute(
    "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(DISTINCT email) AS buyers, COUNT(*) AS orders, SUM(total) AS revenue " +
    "FROM orders WHERE status = 'paid' AND created_at >= ?" + NOT_TEST_ORDER + ' GROUP BY d',
    [from]
  );
  const by = (list) => {
    const map = {};
    list.forEach((r) => { map[r.d] = r; });
    return map;
  };
  const v = by(visitorDays);
  const m = by(minuteDays);
  const o = by(orderDays);
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(today(), -i);
    days.push({
      day: d,
      visitors: v[d] ? v[d].visitors : 0,
      peak: m[d] ? m[d].peak : 0,
      views: m[d] ? m[d].views : 0,
      buyers: o[d] ? o[d].buyers : 0,
      orders: o[d] ? o[d].orders : 0,
      revenue: o[d] ? o[d].revenue : 0
    });
  }

  return {
    day,
    isToday,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    visitors: visitors.n,
    peak: peakRows[0] || null,
    activeNow: isToday ? await activeNow(day) : null,
    buyers: bought.buyers,
    orders: bought.orders,
    revenue: bought.revenue,
    chart: { buckets, max, bucketMinutes: BUCKET_MINUTES },
    days
  };
}

module.exports = { middleware, start, report, validDay };
