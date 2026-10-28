require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');
const db = require('./db');
const logger = require('./logger');
const jobs = require('./jobs');
const analytics = require('./analytics');
const uploads = require('./middleware/upload');
const { locals } = require('./middleware/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

// health checks for the load balancer, before sessions, analytics and logging so they stay cheap
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/health/db', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).send('ok');
  } catch (err) {
    res.status(503).send('database unavailable');
  }
});

if (!process.env.SESSION_SECRET) {
  logger.warn('SESSION_SECRET is not set, using the built-in default secret');
}

// sessions live in MySQL so every app server sees them and a restart does not log anyone out
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 24 * 60 * 60 * 1000,
  createDatabaseTable: false
}, db);

app.use(logger.track);
app.use(express.static(path.join(__dirname, 'public')));
if (uploads.useS3) app.get('/uploads/:file', uploads.serveFromS3);
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'shop-secret-key-123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(logger.requestLogger);
app.use(analytics.middleware);
app.use(locals);

app.use('/', require('./routes/home'));
app.use('/products', require('./routes/products'));
app.use('/cart', require('./routes/cart'));
app.use('/checkout', require('./routes/checkout'));
app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  logger.error(req.method + ' ' + req.originalUrl + ' - ' + (err.stack || err.message));
  if (res.headersSent) return next(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong. Please try again.' });
});

app.listen(3000, () => {
  logger.info('shop listening on port 3000');
  jobs.start();
  analytics.start();
});
