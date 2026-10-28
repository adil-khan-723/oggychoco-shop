const express = require('express');
const db = require('../db');
const wrap = require('../middleware/wrap');
const logger = require('../logger');
const { loadCart } = require('./cart');

const router = express.Router();

// stand-in for a real payment provider
async function chargeCard(orderId, amount) {
  logger.info('mock payment accepted for order ' + orderId + ' amount ' + amount);
  return true;
}

router.get('/', wrap(async (req, res) => {
  const { items, total } = await loadCart(req.session);
  if (items.length === 0) return res.redirect('/cart');
  const u = req.session.user;
  res.render('checkout', {
    title: 'Checkout',
    items,
    total,
    error: null,
    form: { name: u ? u.name : '', email: u ? u.email : '', address: '', city: '', postal_code: '' }
  });
}));

router.post('/', wrap(async (req, res) => {
  const { items, total } = await loadCart(req.session);
  if (items.length === 0) return res.redirect('/cart');

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const form = {
    name: str(req.body.name),
    email: str(req.body.email),
    address: str(req.body.address),
    city: str(req.body.city),
    postal_code: str(req.body.postal_code)
  };

  if (!form.name || !form.email || !form.address || !form.city || !form.postal_code) {
    return res.status(400).render('checkout', { title: 'Checkout', items, total, form, error: 'Please fill in all fields.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(form.email)) {
    return res.status(400).render('checkout', { title: 'Checkout', items, total, form, error: 'Please enter a valid email.' });
  }

  const userId = req.session.user ? req.session.user.id : null;
  let orderId;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO orders (user_id, name, email, address, city, postal_code, total, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, form.name, form.email, form.address, form.city, form.postal_code, total, 'pending']
    );
    orderId = result.insertId;
    for (const item of items) {
      await conn.execute(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
        [orderId, item.id, item.quantity, item.price]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const paid = await chargeCard(orderId, total);
  if (!paid) {
    return res.status(402).render('checkout', { title: 'Checkout', items, total, form, error: 'Payment failed. Please try again.' });
  }
  await db.execute("UPDATE orders SET status = 'paid' WHERE id = ?", [orderId]);

  req.session.cart = {};
  req.session.lastOrderId = orderId;
  logger.info('order ' + orderId + ' placed, total ' + total);
  res.redirect('/checkout/success/' + orderId);
}));

router.get('/success/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [orders] = await db.execute('SELECT * FROM orders WHERE id = ?', [Number.isInteger(id) ? id : 0]);
  const order = orders[0];
  const u = req.session.user;
  const allowed = order && (
    req.session.lastOrderId === order.id ||
    (u && (u.role === 'admin' || u.id === order.user_id))
  );
  if (!allowed) {
    return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  }
  const [items] = await db.execute(
    'SELECT oi.quantity, oi.price, p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?',
    [order.id]
  );
  res.render('order', { title: 'Order confirmed', order, items });
}));

module.exports = router;
