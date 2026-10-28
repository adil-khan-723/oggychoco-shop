const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, 'logs');
const logFile = path.join(logDir, 'app.log');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function log(level, msg) {
  const line = '[' + new Date().toISOString() + '] ' + level + ' ' + msg;
  console.log(line);
  fs.appendFile(logFile, line + '\n', (err) => {
    if (err) console.error('could not write log file: ' + err.message);
  });
}

function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    log('INFO', req.method + ' ' + req.originalUrl + ' ' + res.statusCode + ' ' + (Date.now() - start) + 'ms ' + req.ip);
  });
  next();
}

// concurrency tracking: counts every request, static files included
let inFlight = 0;
let peakInFlight = 0;
let requestsThisMinute = 0;
const lastSeen = new Map();

function track(req, res, next) {
  inFlight++;
  requestsThisMinute++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  lastSeen.set(req.ip, Date.now());
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    inFlight--;
  };
  res.on('finish', end);
  res.on('close', end);
  next();
}

// one line a minute while there is traffic, e.g.
// STATS in_flight_peak=14 active_visitors_5m=42 requests_last_min=310
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, t] of lastSeen) {
    if (t < cutoff) lastSeen.delete(ip);
  }
  if (requestsThisMinute > 0) {
    log('INFO', 'STATS in_flight_peak=' + peakInFlight + ' active_visitors_5m=' + lastSeen.size + ' requests_last_min=' + requestsThisMinute);
  }
  peakInFlight = inFlight;
  requestsThisMinute = 0;
}, 60 * 1000).unref();

module.exports = {
  info: (m) => log('INFO', m),
  warn: (m) => log('WARN', m),
  error: (m) => log('ERROR', m),
  requestLogger,
  track
};
