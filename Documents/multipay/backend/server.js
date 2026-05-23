const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== CONFIG ====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/multipay';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_to_a_32_char_random_string';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d';
const MEGAPAY_API_KEY = process.env.MEGAPAY_API_KEY || '';
const MEGAPAY_EMAIL = process.env.MEGAPAY_EMAIL || '';
const MEGAPAY_URL = 'https://megapay.co.ke/backend/v1/initiatestk';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ==================== MONGOOSE MODELS ====================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 50 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive: { type: Boolean, default: true },
  balance: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'KES' },
  lastLogin: { type: Date }
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.matchPassword = async function(entered) {
  return await bcrypt.compare(entered, this.password);
};

const apiKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  key: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: 'Default Key', trim: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  lastUsedAt: { type: Date },
  usageCount: { type: Number, default: 0 },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) }
}, { timestamps: true });

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  apiKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiKey' },
  type: { type: String, enum: ['deposit', 'stkpush', 'withdrawal', 'refund'], default: 'stkpush' },
  phone: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['pending', 'success', 'failed', 'cancelled'], default: 'pending', index: true },
  refId: { type: String, index: true },
  receipt: { type: String, index: true, sparse: true },
  description: { type: String, default: 'MultiPay STK Push' },
  method: { type: String, default: 'M-Pesa' },
  currency: { type: String, default: 'KES' },
  resultCode: { type: String },
  resultDesc: { type: String },
  rawWebhook: { type: mongoose.Schema.Types.Mixed },
  clientIp: { type: String },
  userAgent: { type: String }
}, { timestamps: true });

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ status: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);
const ApiKey = mongoose.model('ApiKey', apiKeySchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// ==================== MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors({ origin: process.env.CLIENT_URL || '*', credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many attempts. Try again in 15 minutes.' },
  skipSuccessfulRequests: true,
});

const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

app.use(generalLimiter);

// STK Push rate limiter (in-memory)
const stkRequests = new Map();
const stkPushLimiter = (req, res, next) => {
  const key = req.apiKey ? req.apiKey.key : req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReq = 5;
  const timestamps = stkRequests.get(key) || [];
  const valid = timestamps.filter(t => t > now - windowMs);
  if (valid.length >= maxReq) {
    return res.status(429).json({ success: false, message: 'Max 5 STK pushes per minute per API key.' });
  }
  valid.push(now);
  stkRequests.set(key, valid);
  next();
};

// JWT Auth
const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ success: false, message: 'No token provided.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) return res.status(401).json({ success: false, message: 'User not found.' });
    if (!req.user.isActive) return res.status(401).json({ success: false, message: 'Account deactivated.' });
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token invalid.' });
  }
};

// API Key Auth
const apiKeyAuth = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey || req.body.apiKey;
    if (!apiKey) return res.status(401).json({ success: false, message: 'API key required in x-api-key header.' });
    const keyDoc = await ApiKey.findOne({ key: apiKey, status: 'active', expiresAt: { $gt: new Date() } }).populate('userId');
    if (!keyDoc) return res.status(401).json({ success: false, message: 'Invalid or expired API key.' });
    if (!keyDoc.userId || !keyDoc.userId.isActive) return res.status(401).json({ success: false, message: 'Account deactivated.' });
    keyDoc.lastUsedAt = new Date();
    keyDoc.usageCount += 1;
    await keyDoc.save();
    req.apiKey = keyDoc;
    req.user = keyDoc.userId;
    req.userId = keyDoc.userId._id;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'API key validation failed.' });
  }
};

// Utils
const generateApiKey = () => {
  return `mp_live_${crypto.randomBytes(24).toString('hex')}`;
};

const generateToken = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: JWT_EXPIRE });

const formatPhone = (phone) => {
  let fp = phone.replace(/\D/g, '');
  if (fp.startsWith('0')) fp = '254' + fp.slice(1);
  else if (/^[71]/.test(fp) && fp.length === 10) fp = '254' + fp;
  else if (!fp.startsWith('254') && !fp.startsWith('237')) fp = '254' + fp;
  return fp;
};

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', authLimiter, [
  body('name').trim().isLength({ min: 2, max: 50 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    const { name, email, password } = req.body;
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(400).json({ success: false, message: 'User already exists.' });
    const user = await User.create({ name, email: email.toLowerCase(), password });
    const token = generateToken(user._id);
    res.status(201).json({ success: true, message: 'Registered successfully.', token, user: { id: user._id, name: user.name, email: user.email, role: user.role, balance: user.balance } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/auth/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
    if (!user.isActive) return res.status(401).json({ success: false, message: 'Account deactivated.' });
    user.lastLogin = new Date();
    await user.save();
    const token = generateToken(user._id);
    res.status(200).json({ success: true, message: 'Login successful.', token, user: { id: user._id, name: user.name, email: user.email, role: user.role, balance: user.balance, lastLogin: user.lastLogin } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/auth/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ success: true, user: { id: user._id, name: user.name, email: user.email, role: user.role, balance: user.balance, currency: user.currency, createdAt: user.createdAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ==================== API KEY ROUTES ====================
app.post('/api/keys/generate', protect, [
  body('name').optional().trim().isLength({ max: 50 })
], async (req, res) => {
  try {
    const keyValue = generateApiKey();
    const apiKey = await ApiKey.create({ userId: req.user.id, key: keyValue, name: req.body.name || 'Default Key' });
    res.status(201).json({ success: true, message: 'API key generated. Copy it now — it will never be shown again.', apiKey: { id: apiKey._id, key: keyValue, name: apiKey.name, status: apiKey.status, createdAt: apiKey.createdAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to generate key.' });
  }
});

app.get('/api/keys', protect, async (req, res) => {
  try {
    const keys = await ApiKey.find({ userId: req.user.id }).select('-key').sort({ createdAt: -1 });
    res.json({ success: true, count: keys.length, apiKeys: keys });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch keys.' });
  }
});

app.put('/api/keys/:id/revoke', protect, async (req, res) => {
  try {
    const key = await ApiKey.findOne({ _id: req.params.id, userId: req.user.id });
    if (!key) return res.status(404).json({ success: false, message: 'Key not found.' });
    key.status = 'revoked';
    await key.save();
    res.json({ success: true, message: 'Key revoked.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to revoke key.' });
  }
});

// ==================== STK PUSH (MEGAPAY) ====================
app.post('/api/stkpush', apiKeyAuth, stkPushLimiter, [
  body('phone').notEmpty().matches(/^(\+?254|0)?[7]\d{8}$/),
  body('amount').notEmpty().isFloat({ min: 1 }),
  body('accountReference').optional().trim().isLength({ max: 20 }),
  body('description').optional().trim().isLength({ max: 30 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    const { phone, amount, accountReference, description } = req.body;
    const parsedAmount = parseFloat(amount);
    const fp = formatPhone(phone);
    const ref = accountReference || `MP${Date.now()}`;

    // Save pending transaction
    const tx = await Transaction.create({
      userId: req.userId,
      apiKeyId: req.apiKey._id,
      phone: fp,
      amount: parsedAmount,
      status: 'pending',
      refId: ref,
      description: description || 'MultiPay STK Push',
      type: 'stkpush',
      clientIp: req.ip,
      userAgent: req.headers['user-agent']
    });

    // Call Megapay
    const payload = {
      api_key: MEGAPAY_API_KEY,
      email: MEGAPAY_EMAIL,
      amount: parsedAmount,
      msisdn: fp,
      callback_url: `${APP_URL}/api/webhook/megapay`,
      description: description || 'MultiPay Payment',
      reference: ref
    };

    let mpData;
    try {
      const mpRes = await axios.post(MEGAPAY_URL, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });
      mpData = mpRes.data;
      if (mpData && (mpData.status === false || mpData.success === false || mpData.ResponseCode === '1')) {
        tx.status = 'failed';
        tx.resultDesc = mpData.errorMessage || mpData.message || 'Megapay rejected request';
        await tx.save();
        return res.status(400).json({ success: false, message: tx.resultDesc, transactionId: tx._id });
      }
    } catch (mpErr) {
      tx.status = 'failed';
      tx.resultDesc = 'Payment gateway failed to send STK push';
      await tx.save();
      return res.status(502).json({ success: false, message: 'Payment gateway failed.', transactionId: tx._id });
    }

    tx.resultCode = mpData.ResponseCode || mpData.resultCode || '0';
    tx.resultDesc = mpData.CustomerMessage || mpData.message || 'STK Push sent';
    await tx.save();

    res.json({
      success: true,
      message: tx.resultDesc || 'STK Push sent to phone.',
      transactionId: tx._id,
      refId: ref,
      status: 'pending',
      phone: fp,
      amount: parsedAmount,
      pollUrl: `/api/transactions/${tx._id}/status`
    });
  } catch (err) {
    console.error('STK Push error:', err);
    res.status(500).json({ success: false, message: 'Server error initiating STK Push.' });
  }
});

// ==================== WEBHOOK (MEGAPAY) ====================
app.post('/api/webhook/megapay', async (req, res) => {
  res.status(200).send('OK');
  try {
    const data = req.body || {};
    console.log('Megapay webhook received:', JSON.stringify(data, null, 2));

    const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;
    if (responseCode != 0) {
      console.log('Webhook non-zero response code:', responseCode, data);
      // Find and mark failed
      const ref = data.reference || data.Reference || data.BillRefNumber;
      if (ref) {
        const tx = await Transaction.findOne({ refId: ref });
        if (tx) {
          tx.status = 'failed';
          tx.resultCode = String(responseCode);
          tx.resultDesc = data.errorMessage || data.message || 'Transaction failed';
          tx.rawWebhook = data;
          await tx.save();
        }
      }
      return;
    }

    const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
    const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.receipt || data.transID || data.Receipt;
    const phoneRaw = String(data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || data.BillRefNumber || "");
    const last9 = phoneRaw.replace(/\D/g, '').slice(-9);
    const ref = data.reference || data.Reference || data.BillRefNumber;

    if (isNaN(amount) || amount <= 0) { console.error('Webhook invalid amount:', data); return; }
    if (!receipt) { console.error('Webhook missing receipt:', data); return; }

    // Find by reference first
    let tx = null;
    if (ref) tx = await Transaction.findOne({ refId: ref });
    // Fallback: find by phone ending
    if (!tx && last9.length >= 9) {
      tx = await Transaction.findOne({ phone: { $regex: new RegExp(last9 + '$') }, status: 'pending' }).sort({ createdAt: -1 });
    }
    if (!tx) { console.error('Webhook: no matching transaction found. Ref:', ref, 'Phone ending:', last9); return; }

    // Check duplicate
    const existing = await Transaction.findOne({ receipt, _id: { $ne: tx._id } });
    if (existing) { console.log('Duplicate receipt skipped:', receipt); return; }

    // Update transaction
    tx.status = 'success';
    tx.receipt = receipt;
    tx.resultCode = '0';
    tx.resultDesc = data.ResultDesc || 'Payment successful';
    tx.rawWebhook = data;
    await tx.save();

    // Update user balance
    const user = await User.findById(tx.userId);
    if (user) {
      const oldBal = user.balance;
      user.balance += amount;
      await user.save();
      console.log(`User ${user.email} credited: ${oldBal} -> ${user.balance}`);
    }

    console.log(`Transaction ${tx._id} marked success. Receipt: ${receipt}`);
  } catch (err) {
    console.error('Webhook fatal error:', err.message);
  }
});

// ==================== TRANSACTIONS ====================
app.get('/api/transactions', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const query = { userId: req.user.id };
    if (req.query.status) query.status = req.query.status;
    const txs = await Transaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-rawWebhook');
    const total = await Transaction.countDocuments(query);
    res.json({ success: true, count: txs.length, total, page, pages: Math.ceil(total / limit), transactions: txs });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch transactions.' });
  }
});

app.get('/api/transactions/:id', protect, async (req, res) => {
  try {
    const tx = await Transaction.findOne({ _id: req.params.id, userId: req.user.id });
    if (!tx) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, transaction: tx });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/transactions/:id/status', apiKeyAuth, async (req, res) => {
  try {
    const tx = await Transaction.findOne({ _id: req.params.id, userId: req.userId }).select('status phone amount receipt refId resultDesc createdAt updatedAt');
    if (!tx) return res.status(404).json({ success: false, message: 'Not found.' });
    res.json({ success: true, status: tx.status, transaction: tx });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/wallet', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ success: true, wallet: { balance: user.balance, currency: user.currency } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ==================== HEALTH & FRONTEND ====================
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'MultiPay API running', timestamp: new Date().toISOString(), env: process.env.NODE_ENV || 'development' });
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'register.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'dashboard.html')));
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'docs.html')));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal Server Error' });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// ==================== START ====================
const start = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB Connected');
    app.listen(PORT, () => {
      console.log(`MultiPay server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    });
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
};

start();
