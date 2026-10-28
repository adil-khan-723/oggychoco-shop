const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const wrap = require('../middleware/wrap');
const logger = require('../logger');

const router = express.Router();

function safeNext(value) {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value;
  return '/';
}

router.get('/register', (req, res) => {
  res.render('register', { title: 'Register', error: null, form: { name: '', email: '' }, next: safeNext(req.query.next) });
});

router.post('/register', wrap(async (req, res) => {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const name = str(req.body.name);
  const email = str(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const next = safeNext(req.body.next);
  const form = { name, email };

  let error = null;
  if (!name || !email || !password) error = 'Please fill in all fields.';
  else if (!/^\S+@\S+\.\S+$/.test(email)) error = 'Please enter a valid email.';
  else if (password.length < 6) error = 'Password must be at least 6 characters.';
  if (error) {
    return res.status(400).render('register', { title: 'Register', error, form, next });
  }

  const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    return res.status(400).render('register', { title: 'Register', error: 'That email is already registered.', form, next });
  }

  const hash = await bcrypt.hash(password, 10);
  let result;
  try {
    [result] = await db.execute(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name, email, hash, 'customer']
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).render('register', { title: 'Register', error: 'That email is already registered.', form, next });
    }
    throw err;
  }

  req.session.user = { id: result.insertId, name, email, role: 'customer' };
  logger.info('new user registered: ' + email);
  res.redirect(next);
}));

router.get('/login', (req, res) => {
  res.render('login', { title: 'Login', error: null, email: '', next: safeNext(req.query.next) });
});

router.post('/login', wrap(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const next = safeNext(req.body.next);

  const [rows] = await db.execute('SELECT id, name, email, password_hash, role FROM users WHERE email = ?', [email]);
  const found = rows[0];
  const ok = found ? await bcrypt.compare(password, found.password_hash) : false;
  if (!ok) {
    logger.warn('failed login for ' + email);
    return res.status(401).render('login', { title: 'Login', error: 'Invalid email or password.', email, next });
  }

  req.session.user = { id: found.id, name: found.name, email: found.email, role: found.role };
  logger.info('user logged in: ' + email);
  res.redirect(next);
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;
