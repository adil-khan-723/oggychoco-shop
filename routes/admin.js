const express = require('express');
const db = require('../db');
const wrap = require('../middleware/wrap');
const logger = require('../logger');
const analytics = require('../analytics');
const { requireAdmin } = require('../middleware/auth');
const { productImage } = require('../middleware/upload');

const router = express.Router();

router.use(requireAdmin);

async function categoryList() {
  const [categories] = await db.execute('SELECT id, name FROM categories ORDER BY id');
  return categories;
}

function readForm(body) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    name: str(body.name),
    description: str(body.description),
    price: str(body.price),
    category_id: parseInt(body.category_id, 10),
    featured: body.featured ? 1 : 0
  };
}

function validate(form) {
  if (!form.name) return 'Name is required.';
  const price = Number(form.price);
  if (form.price === '' || !Number.isFinite(price) || price < 0 || price > 99999999) return 'Enter a valid price.';
  if (!Number.isInteger(form.category_id)) return 'Choose a category.';
  return null;
}

router.get('/', (req, res) => res.redirect('/admin/products'));

router.get('/analytics', wrap(async (req, res) => {
  const data = await analytics.report(analytics.validDay(req.query.day));
  res.render('admin/analytics', { title: 'Analytics', ...data });
}));

router.get('/products', wrap(async (req, res) => {
  const [products] = await db.execute(
    'SELECT p.id, p.name, p.price, p.image, p.featured, c.name AS category_name ' +
    'FROM products p JOIN categories c ON c.id = p.category_id ORDER BY p.id'
  );
  res.render('admin/products', { title: 'Manage products', products });
}));

router.get('/products/new', wrap(async (req, res) => {
  res.render('admin/product-form', {
    title: 'Add product',
    product: { id: null, name: '', description: '', price: '', category_id: '', featured: 0, image: null },
    categories: await categoryList(),
    error: null
  });
}));

router.post('/products', productImage, wrap(async (req, res) => {
  const form = readForm(req.body);
  const error = req.uploadError || validate(form);
  if (error) {
    return res.status(400).render('admin/product-form', {
      title: 'Add product',
      product: { id: null, image: null, ...form },
      categories: await categoryList(),
      error
    });
  }
  const image = req.file ? '/uploads/' + req.file.filename : '/images/placeholder.svg';
  try {
    await db.execute(
      'INSERT INTO products (category_id, name, description, price, image, featured) VALUES (?, ?, ?, ?, ?, ?)',
      [form.category_id, form.name, form.description, form.price, image, form.featured]
    );
  } catch (err) {
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).render('admin/product-form', {
        title: 'Add product',
        product: { id: null, image: null, ...form },
        categories: await categoryList(),
        error: 'Choose a valid category.'
      });
    }
    throw err;
  }
  logger.info('admin ' + req.session.user.email + ' added product ' + form.name);
  res.redirect('/admin/products');
}));

router.get('/products/:id/edit', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [rows] = await db.execute(
    'SELECT id, category_id, name, description, price, image, featured FROM products WHERE id = ?',
    [Number.isInteger(id) ? id : 0]
  );
  if (rows.length === 0) {
    return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  }
  res.render('admin/product-form', {
    title: 'Edit product',
    product: rows[0],
    categories: await categoryList(),
    error: null
  });
}));

router.post('/products/:id', productImage, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [rows] = await db.execute('SELECT id, image FROM products WHERE id = ?', [Number.isInteger(id) ? id : 0]);
  if (rows.length === 0) {
    return res.status(404).render('error', { title: 'Not found', message: 'Product not found.' });
  }
  const form = readForm(req.body);
  const error = req.uploadError || validate(form);
  if (error) {
    return res.status(400).render('admin/product-form', {
      title: 'Edit product',
      product: { id, image: rows[0].image, ...form },
      categories: await categoryList(),
      error
    });
  }
  const image = req.file ? '/uploads/' + req.file.filename : rows[0].image;
  try {
    await db.execute(
      'UPDATE products SET category_id = ?, name = ?, description = ?, price = ?, image = ?, featured = ? WHERE id = ?',
      [form.category_id, form.name, form.description, form.price, image, form.featured, id]
    );
  } catch (err) {
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).render('admin/product-form', {
        title: 'Edit product',
        product: { id, image: rows[0].image, ...form },
        categories: await categoryList(),
        error: 'Choose a valid category.'
      });
    }
    throw err;
  }
  logger.info('admin ' + req.session.user.email + ' updated product ' + id);
  res.redirect('/admin/products');
}));

module.exports = router;
