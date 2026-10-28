const bcrypt = require('bcrypt');
const db = require('./db');

const categories = [
  { name: 'Electronics', slug: 'electronics' },
  { name: 'Clothing', slug: 'clothing' },
  { name: 'Home & Kitchen', slug: 'home-kitchen' },
  { name: 'Books', slug: 'books' }
];

// [category slug, name, price, description]
const products = [
  ['electronics', 'Wireless Earbuds', 59.99, 'Compact earbuds with 24 hour battery life and a pocket-sized charging case.'],
  ['electronics', 'Bluetooth Speaker', 39.99, 'Water resistant speaker with surprisingly big sound for its size.'],
  ['electronics', 'Smart Watch', 129.00, 'Track steps, sleep and heart rate with a bright always-on display.'],
  ['electronics', 'USB-C Fast Charger', 24.50, '45W wall charger that powers laptops, tablets and phones.'],
  ['electronics', 'Mechanical Keyboard', 89.90, 'Tactile switches, white backlight and a sturdy aluminium frame.'],
  ['clothing', 'Classic Denim Jacket', 74.00, 'A timeless mid-wash jacket cut for layering all year round.'],
  ['clothing', 'Cotton T-Shirt', 19.99, 'Soft everyday tee made from 100% combed cotton.'],
  ['clothing', 'Running Sneakers', 64.95, 'Lightweight trainers with a cushioned sole and breathable mesh.'],
  ['clothing', 'Wool Beanie', 14.50, 'Warm knitted beanie that keeps its shape wash after wash.'],
  ['clothing', 'Canvas Backpack', 44.00, 'Roomy 20 litre backpack with a padded laptop sleeve.'],
  ['home-kitchen', 'Ceramic Coffee Mug Set', 28.00, 'Set of four hand glazed mugs, dishwasher and microwave safe.'],
  ['home-kitchen', 'Non-stick Frying Pan', 34.99, '28cm pan with an even heating base and a cool-touch handle.'],
  ['home-kitchen', 'Aroma Diffuser', 31.50, 'Ultrasonic diffuser with soft ambient light and auto shut-off.'],
  ['home-kitchen', 'Cotton Bath Towels', 26.00, 'Pack of two thick, absorbent towels in a neutral grey.'],
  ['home-kitchen', 'Bamboo Cutting Board', 18.75, 'Durable board with a juice groove, gentle on knives.'],
  ['books', 'Cooking for Beginners', 16.00, 'Simple recipes and techniques to get confident in the kitchen.'],
  ['books', 'Mystery at Blackwater', 12.99, 'A gripping small-town mystery with a twist on every page.'],
  ['books', 'A Short History of Cloud', 21.50, 'How computing moved from machine rooms to the sky, told plainly.'],
  ['books', 'The Habit of Saving', 15.25, 'Practical, no-nonsense ideas for building savings over time.'],
  ['books', 'Garden Notes', 17.80, 'A seasonal guide to growing vegetables and flowers at home.']
];

const featuredIndexes = [0, 1, 5, 6, 10, 11, 15, 16];

async function main() {
  const adminHash = await bcrypt.hash('admin', 10);
  await db.execute(
    "INSERT IGNORE INTO users (name, email, password_hash, role) VALUES ('Admin', 'admin', ?, 'admin')",
    [adminHash]
  );

  for (const c of categories) {
    await db.execute('INSERT IGNORE INTO categories (name, slug) VALUES (?, ?)', [c.name, c.slug]);
  }

  const [existing] = await db.execute('SELECT COUNT(*) AS n FROM products');
  if (existing[0].n > 0) {
    console.log('products already present, skipping product seed');
  } else {
    const [cats] = await db.execute('SELECT id, slug FROM categories');
    const catId = {};
    cats.forEach((c) => { catId[c.slug] = c.id; });

    for (let i = 0; i < products.length; i++) {
      const [slug, name, price, description] = products[i];
      await db.execute(
        'INSERT INTO products (category_id, name, description, price, image, featured) VALUES (?, ?, ?, ?, ?, ?)',
        [catId[slug], name, description, price, '/images/products/p' + (i + 1) + '.svg', featuredIndexes.includes(i) ? 1 : 0]
      );
    }
    console.log('seeded ' + products.length + ' products');
  }

  console.log('done. admin login: admin / admin');
}

main()
  .catch((err) => {
    console.error('seed failed: ' + err.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
