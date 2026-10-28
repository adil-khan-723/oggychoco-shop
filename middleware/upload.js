const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');
const logger = require('../logger');

const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

// with UPLOADS_BUCKET set, images go to S3 so every app server can show them; otherwise to public/uploads
const bucket = process.env.UPLOADS_BUCKET || '';
const useS3 = bucket !== '';
const prefix = 'uploads/';

let s3 = null;
let PutObjectCommand = null;
let GetObjectCommand = null;
if (useS3) {
  const sdk = require('@aws-sdk/client-s3');
  s3 = new sdk.S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
  PutObjectCommand = sdk.PutObjectCommand;
  GetObjectCommand = sdk.GetObjectCommand;
}

function newName(originalname) {
  const ext = path.extname(originalname).toLowerCase();
  return Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext;
}

const storage = useS3
  ? multer.memoryStorage()
  : multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'uploads'),
    filename: (req, file, cb) => cb(null, newName(file.originalname))
  });

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') && allowed.includes(ext)) {
      return cb(null, true);
    }
    cb(new Error('Only jpg, png, gif or webp images are allowed'));
  }
});

// runs multer and keeps the error on the request so the form can show it
function productImage(req, res, next) {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 2MB' : err.message;
      return next();
    }
    if (useS3 && req.file) {
      const filename = newName(req.file.originalname);
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: prefix + filename,
          Body: req.file.buffer,
          ContentType: types[path.extname(filename)]
        }));
        req.file.filename = filename;
      } catch (e) {
        logger.error('image upload to S3 failed: ' + e.message);
        req.file = undefined;
        req.uploadError = 'Could not save the image, please try again';
      }
    }
    next();
  });
}

// serves /uploads/<name> from S3 (only used when UPLOADS_BUCKET is set; local files are served by express.static)
async function serveFromS3(req, res, next) {
  const name = req.params.file;
  if (!/^\d+-[0-9a-f]{12}\.(jpg|jpeg|png|gif|webp)$/.test(name)) return next();
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + name }));
    res.set('Content-Type', types[path.extname(name)]);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    pipeline(out.Body, res, (e) => {
      if (e && !res.headersSent) next(e);
    });
  } catch (e) {
    if (e.name === 'NoSuchKey') return next();
    next(e);
  }
}

module.exports = { productImage, serveFromS3, useS3 };
