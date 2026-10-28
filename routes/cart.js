const express = require('express');
const db = require('../db');
const wrap = require('../middleware/wrap');

const router = express.Router();

// turns the {productId: qty} map in the session into rows with current prices
async function loadCart(session) {
  const cart = session.cart || {};
  const ids = Object.keys(cart).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return { items: [], total: 0 };

  const [rows] = await db.query('SELECT id, name, price, image FROM products WHERE id IN (?)', [ids]);
  const items = rows.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    image: p.image,
    quantity: cart[p.id],
    subtotal: Math.round(p.price * cart[p.id] * 100) / 100
  }));
  const total = Math.round(items.reduce((sum, i) => sum + i.subtotal, 0) * 100) / 100;
  return { items, total };
}

function parseQty(value) {
  const qty = parseInt(value, 10);
  if (!Number.isInteger(qty)) return null;
  return Math.max(0, Math.min(qty, 99));
}

router.get('/', wrap(async (req, res) => {
  const { items, total } = await loadCart(req.session);
  res.render('cart', { title: 'Your cart', items, total });
}));

router.post('/add', wrap(async (req, res) => {
  const id = parseInt(req.body.productId, 10);
  const qty = parseQty(req.body.quantity === undefined ? 1 : req.body.quantity);
  if (!Number.isInteger(id) || !qty) {
    return res.status(400).render('error', { title: 'Error', message: 'Invalid product or quantity.' });
  }
  const [rows] = await db.execute('SELECT id FROM products WHERE id = ?', [id]);
  if (rows.length === 0) {
    return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  }
  const cart = req.session.cart || {};
  cart[id] = Math.min((cart[id] || 0) + qty, 99);
  req.session.cart = cart;
  res.redirect('/cart');
}));

router.post('/update', (req, res) => {
  const id = parseInt(req.body.productId, 10);
  const qty = parseQty(req.body.quantity);
  const cart = req.session.cart || {};
  if (Number.isInteger(id) && qty !== null && cart[id]) {
    if (qty === 0) delete cart[id];
    else cart[id] = qty;
  }
  req.session.cart = cart;
  res.redirect('/cart');
});

router.post('/remove', (req, res) => {
  const id = parseInt(req.body.productId, 10);
  const cart = req.session.cart || {};
  delete cart[id];
  req.session.cart = cart;
  res.redirect('/cart');
});

module.exports = router;
module.exports.loadCart = loadCart;
