function locals(req, res, next) {
  res.locals.user = req.session.user || null;
  const cart = req.session.cart || {};
  res.locals.cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  res.locals.money = (n) => '$' + Number(n).toFixed(2);
  res.locals.title = 'Shop';
  next();
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admins only.' });
  }
  next();
}

module.exports = { locals, requireLogin, requireAdmin };
