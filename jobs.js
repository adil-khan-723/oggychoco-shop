const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');

function start() {
  // every night at 03:00 clean out orders that never got paid
  cron.schedule('0 3 * * *', async () => {
    try {
      const [result] = await db.execute(
        "DELETE FROM orders WHERE status = 'pending' AND created_at < NOW() - INTERVAL 24 HOUR"
      );
      logger.info('nightly cleanup removed ' + result.affectedRows + ' pending orders');
      await db.execute('DELETE FROM analytics_minutes WHERE minute < NOW() - INTERVAL 90 DAY');
      await db.execute('DELETE FROM analytics_visitors WHERE day < CURDATE() - INTERVAL 90 DAY');
    } catch (err) {
      logger.error('nightly cleanup failed: ' + err.message);
    }
  });
  logger.info('scheduled jobs started');
}

module.exports = { start };
