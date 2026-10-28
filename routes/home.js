const express = require('express');
const db = require('../db');
const wrap = require('../middleware/wrap');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const [featured] = await db.execute(
    'SELECT p.id, p.name, p.price, p.image, c.name AS category_name ' +
    'FROM products p JOIN categories c ON c.id = p.category_id ' +
    'WHERE p.featured = 1 ORDER BY p.id LIMIT 8'
  );
  const [categories] = await db.execute('SELECT id, name, slug FROM categories ORDER BY id');
  res.render('index', { title: 'Home', featured, categories });
}));

module.exports = router;
