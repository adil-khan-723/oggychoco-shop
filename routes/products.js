const express = require('express');
const db = require('../db');
const wrap = require('../middleware/wrap');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category : '';

  let sql = 'SELECT p.id, p.name, p.price, p.image, c.name AS category_name ' +
    'FROM products p JOIN categories c ON c.id = p.category_id WHERE 1 = 1';
  const params = [];

  if (category) {
    sql += ' AND c.slug = ?';
    params.push(category);
  }
  if (q) {
    sql += ' AND (p.name LIKE ? OR p.description LIKE ?)';
    params.push('%' + q + '%', '%' + q + '%');
  }
  sql += ' ORDER BY p.id';

  const [products] = await db.execute(sql, params);
  const [categories] = await db.execute('SELECT id, name, slug FROM categories ORDER BY id');
  res.render('products', { title: 'Products', products, categories, q, category });
}));

router.get('/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  }
  const [rows] = await db.execute(
    'SELECT p.id, p.name, p.description, p.price, p.image, c.name AS category_name, c.slug AS category_slug ' +
    'FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?',
    [id]
  );
  if (rows.length === 0) {
    return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  }
  res.render('product', { title: rows[0].name, product: rows[0] });
}));

module.exports = router;
