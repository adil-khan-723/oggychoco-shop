import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL;

// number of seeded products (ids 1..N)
const PRODUCT_COUNT = 20;

// concurrent users per step: edit the list, or pass e.g. -e STEPS=60,80,100
const STEPS = (__ENV.STEPS || '50,100,200,300,500,750,1000').split(',').map(Number);
const RAMP = 30; // seconds to reach the step's users
const HOLD = 90; // seconds at the step's users
const GAP = 40; // seconds before the next step, lets the last one drain

const scenarios = {};
const thresholds = { checks: ['rate>0.95'] };

// each step has its own thresholds, and the first step to fail aborts the run,
// so the last passing step is the number of concurrent users the app handled
STEPS.forEach((users, i) => {
  const step = `vu${users}`;
  scenarios[step] = {
    executor: 'ramping-vus',
    startTime: `${i * (RAMP + HOLD + GAP)}s`,
    startVUs: 0,
    stages: [
      { duration: `${RAMP}s`, target: users },
      { duration: `${HOLD}s`, target: users },
      { duration: '1s', target: 0 },
    ],
    gracefulRampDown: '30s',
    tags: { step },
  };
  const abort = (threshold) => ({ threshold, abortOnFail: true, delayAbortEval: '30s' });
  thresholds[`http_req_duration{step:${step}}`] = [abort('p(95)<1500')];
  thresholds[`http_req_failed{step:${step}}`] = [abort('rate<0.05')];
  thresholds[`checks{step:${step}}`] = [abort('rate>0.95')];
});

export const options = { scenarios, thresholds };

export function setup() {
  if (!BASE_URL) {
    throw new Error('BASE_URL is not set, e.g. BASE_URL=https://shop.example.com k6 run shopper.js');
  }
}

function think() {
  sleep(1 + Math.random() * 2);
}

export default function () {
  const stamp = `${__VU}-${__ITER}-${Date.now()}`;
  const email = `shopper-${stamp}@loadtest.local`;
  const password = 'Passw0rd!123';
  const productId = 1 + Math.floor(Math.random() * PRODUCT_COUNT);

  // browse home
  let res = http.get(`${BASE_URL}/`, { tags: { name: 'GET /' } });
  check(res, { 'home 200': (r) => r.status === 200 });
  think();

  // list products
  res = http.get(`${BASE_URL}/products`, { tags: { name: 'GET /products' } });
  check(res, { 'products 200': (r) => r.status === 200 });
  think();

  // view a product
  res = http.get(`${BASE_URL}/products/${productId}`, { tags: { name: 'GET /products/:id' } });
  check(res, { 'product 200': (r) => r.status === 200 });
  think();

  // register
  res = http.post(
    `${BASE_URL}/register`,
    { name: `Shopper ${stamp}`, email, password, next: '/' },
    { tags: { name: 'POST /register' } }
  );
  check(res, { 'register 200': (r) => r.status === 200 });
  think();

  // login
  res = http.post(
    `${BASE_URL}/login`,
    { email, password, next: '/' },
    { tags: { name: 'POST /login' } }
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  think();

  // add to cart
  res = http.post(
    `${BASE_URL}/cart/add`,
    { productId: String(productId), quantity: '1' },
    { tags: { name: 'POST /cart/add' } }
  );
  check(res, {
    'add to cart 200': (r) => r.status === 200,
    'cart has item': (r) => r.body.indexOf('Checkout') !== -1,
  });
  think();

  // checkout
  res = http.get(`${BASE_URL}/checkout`, { tags: { name: 'GET /checkout' } });
  check(res, { 'checkout page 200': (r) => r.status === 200 });
  think();

  res = http.post(
    `${BASE_URL}/checkout`,
    {
      name: `Shopper ${stamp}`,
      email,
      address: '1 Test Street',
      city: 'Testville',
      postal_code: '12345',
    },
    { tags: { name: 'POST /checkout' } }
  );
  check(res, {
    'order placed 200': (r) => r.status === 200,
    'order confirmed': (r) => r.body.indexOf('Thank you for your order') !== -1,
  });
  think();
}
