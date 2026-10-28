require('dotenv').config();
const mysql = require('mysql2');

// the defaults match the single-server install; set DB_* in .env when the database is on another host
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'shop',
  password: process.env.DB_PASSWORD || 'shoppass123',
  database: process.env.DB_NAME || 'shop',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true
});

module.exports = pool.promise();
