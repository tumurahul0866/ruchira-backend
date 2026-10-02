import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { sendPasswordResetOTP } from './services/emailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const requiresStableJwtSecret =
  process.env.NODE_ENV === 'production' ||
  process.env.VERCEL === '1' ||
  process.env.VERCEL === 'true' ||
  Boolean(process.env.VERCEL_ENV) ||
  Boolean(process.env.NOW_REGION);
const JWT_SECRET = process.env.JWT_SECRET || (requiresStableJwtSecret ? '' : crypto.randomBytes(32).toString('hex'));
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (requiresStableJwtSecret && (!JWT_SECRET || JWT_SECRET.length < 32)) {
  throw new Error('A JWT_SECRET of at least 32 characters must be configured for production and serverless deployments.');
}
if (requiresStableJwtSecret && (!process.env.DEFAULT_ADMIN_PASSWORD || Buffer.byteLength(process.env.DEFAULT_ADMIN_PASSWORD, 'utf8') < 12 || Buffer.byteLength(process.env.DEFAULT_ADMIN_PASSWORD, 'utf8') > 72)) {
  throw new Error('DEFAULT_ADMIN_PASSWORD must be between 12 and 72 UTF-8 bytes for production deployments.');
}

const isVercel =
  process.env.VERCEL === '1' ||
  process.env.VERCEL === 'true' ||
  Boolean(process.env.VERCEL_ENV) ||
  Boolean(process.env.NOW_REGION);
const dataDir = isVercel
  ? path.join(os.tmpdir(), 'vasuki-data')
  : path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'admin-settings.json');
const productsFile = path.join(dataDir, 'products.json');
const ordersFile = path.join(dataDir, 'orders.json');
const reviewsFile = path.join(dataDir, 'reviews.json');
const offersFile = path.join(dataDir, 'offers.json');
const storeSettingsFile = path.join(dataDir, 'store-settings.json');
const paymentSettingsFile = path.join(dataDir, 'payment-settings.json');
const userProfilesFile = path.join(dataDir, 'user-profiles.json');
const adminProfileFile = path.join(dataDir, 'admin-profile.json');
const productTypesFile = path.join(dataDir, 'product-types.json');
const shippingRulesFile = path.join(dataDir, 'shipping-rules.json');

const defaultCredentials = {
  email: process.env.DEFAULT_ADMIN_EMAIL || 'ruchira@gmail.com',
  password: process.env.DEFAULT_ADMIN_PASSWORD || '',
};

const databaseUrl = process.env.DATABASE_URL?.trim();
const isPostgresEnabled = Boolean(databaseUrl);
const pool = isPostgresEnabled
  ? new pg.Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// Helper to run and log SQL queries with timing and error capture
async function runQueryLogged(sql, params = []) {
  if (!pool) {
    throw new Error('Postgres pool is not initialized');
  }
  return pool.query(sql, params);
}

const PRODUCT_COLUMNS = [
  'id',
  'name',
  'category',
  'product_type',
  'quantity_type',
  'price_per_unit',
  'weights',
  'spice_level',
  'description',
  'ingredients',
  'shelf_life',
  'discount_price',
  'bulk_price',
  'stock_quantity',
  'in_stock',
  'best_seller',
  'new_arrival',
  'visible',
  'rating',
  'reviews_count',
  'image',
  'additional_images',
];

const productInsertQuery = `
  INSERT INTO products (${PRODUCT_COLUMNS.join(',')})
  VALUES (${PRODUCT_COLUMNS.map((_, index) => `$${index + 1}`).join(',')})
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    product_type = EXCLUDED.product_type,
    quantity_type = EXCLUDED.quantity_type,
    price_per_unit = EXCLUDED.price_per_unit,
    weights = EXCLUDED.weights,
    spice_level = EXCLUDED.spice_level,
    description = EXCLUDED.description,
    ingredients = EXCLUDED.ingredients,
    shelf_life = EXCLUDED.shelf_life,
    discount_price = EXCLUDED.discount_price,
    bulk_price = EXCLUDED.bulk_price,
    stock_quantity = EXCLUDED.stock_quantity,
    in_stock = EXCLUDED.in_stock,
    best_seller = EXCLUDED.best_seller,
    new_arrival = EXCLUDED.new_arrival,
    visible = EXCLUDED.visible,
    rating = EXCLUDED.rating,
    reviews_count = EXCLUDED.reviews_count,
    image = EXCLUDED.image,
    additional_images = EXCLUDED.additional_images;
`;

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeProduct(product) {
  const weights = parseJsonValue(product.weights);
  const additionalImages = parseJsonValue(product.additionalImages ?? product.additional_images);

  return {
    id: product.id,
    name: product.name,
    category: product.category,
    productType: product.productType ?? product.product_type,
    quantityType: product.quantityType ?? product.quantity_type ?? 'Weight',
    pricePerUnit: Number(product.pricePerUnit ?? product.price_per_unit) || (Array.isArray(weights) && weights[0] ? Number(weights[0].price) : 0),
    weights: Array.isArray(weights) ? weights : [],
    spiceLevel: product.spiceLevel ?? product.spice_level,
    description: product.description,
    ingredients: product.ingredients,
    shelfLife: product.shelfLife ?? product.shelf_life,
    discountPrice: Number(product.discountPrice ?? product.discount_price) || 0,
    bulkPrice: Number(product.bulkPrice ?? product.bulk_price) || 0,
    stockQuantity: Number(product.stockQuantity ?? product.stock_quantity) || 0,
    inStock: product.inStock ?? product.in_stock,
    bestSeller: product.bestSeller ?? product.best_seller,
    newArrival: product.newArrival ?? product.new_arrival,
    visible: product.visible,
    rating: Number(product.rating) || 0,
    reviewsCount: Number(product.reviewsCount ?? product.reviews_count) || 0,
    image: product.image,
    additionalImages: Array.isArray(additionalImages) ? additionalImages : [],
  };
}

function normalizeProductInput(item) {
  return {
    ...item,
    quantityType: item.quantityType ?? item.quantity_type ?? 'Weight',
    pricePerUnit: Number(item.pricePerUnit ?? item.price_per_unit) || 0,
    weights: Array.isArray(item.weights) ? item.weights : [],
    additionalImages: Array.isArray(item.additionalImages) ? item.additionalImages : [],
  };
}

function normalizeOrderItem(item) {
  const parsedItem = deepParseJsonValue(item);
  const product = deepParseJsonValue(parsedItem?.product);
  return {
    ...parsedItem,
    product: typeof product === 'string' ? { name: product } : product || {},
    quantity: parsedItem?.quantity,
  };
}

function normalizeOrderPayload(order) {
  const parsedOrder = deepParseJsonValue(order);
  const customer = deepParseJsonValue(parsedOrder?.customer);
  const items = deepParseJsonValue(parsedOrder?.items);

  return {
    ...parsedOrder,
    customer: typeof customer === 'string' ? { name: customer } : customer || {},
    items: Array.isArray(items) ? items.map(normalizeOrderItem) : [],
  };
}

function productRowParams(product) {
  const serializeJson = (value) => {
    if (value == null) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  };

  const normalizeArray = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map((item) => serializeJson(item));
  };

  const normalizeJsonColumn = (value) => {
    return JSON.stringify(normalizeArray(value));
  };

  return [
    product.id,
    product.name,
    product.category,
    product.productType,
    product.quantityType,
    product.pricePerUnit,
    normalizeJsonColumn(product.weights),
    product.spiceLevel,
    product.description,
    product.ingredients,
    product.shelfLife,
    product.discountPrice,
    product.bulkPrice,
    product.stockQuantity,
    product.inStock,
    product.bestSeller,
    product.newArrival,
    product.visible,
    product.rating,
    product.reviewsCount,
    product.image,
    normalizeJsonColumn(product.additionalImages),
  ];
}

// Ensure database tables exist without changing product rows.
async function ensureDatabase() {
  const DB_TIMEOUT_MS = 15000;
  const withDbTimeout = (promise, step) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${DB_TIMEOUT_MS}ms in ${step}`)), DB_TIMEOUT_MS))
  ]);

  if (!pool) return;
  if (global.__dbInitialized) return;
  if (!pool) return;

  console.log('DB init: creating admin_credentials');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS admin_credentials (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `), 'create admin_credentials');
  console.log('DB init: admin_credentials ready');

  console.log('DB init: creating products table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      product_type TEXT,
      quantity_type TEXT,
      price_per_unit NUMERIC,
      weights JSONB,
      spice_level TEXT,
      description TEXT,
      ingredients TEXT,
      shelf_life TEXT,
      discount_price NUMERIC,
      bulk_price NUMERIC,
      stock_quantity INTEGER,
      in_stock BOOLEAN,
      best_seller BOOLEAN,
      new_arrival BOOLEAN,
      visible BOOLEAN,
      rating NUMERIC,
      reviews_count INTEGER,
      image TEXT,
      additional_images JSONB
    );
  `), 'create products');
  console.log('DB init: products table ready');

  console.log('DB init: adding quantity_type column');
  await withDbTimeout(runQueryLogged(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS quantity_type TEXT;
  `), 'add quantity_type column');
  console.log('DB init: quantity_type column ready');

  console.log('DB init: adding price_per_unit column');
  await withDbTimeout(runQueryLogged(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS price_per_unit NUMERIC;
  `), 'add price_per_unit column');
  console.log('DB init: price_per_unit column ready');

  console.log('DB init: creating orders table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      date TIMESTAMPTZ,
      status TEXT,
      payment_status TEXT,
      payment_method TEXT,
      total_amount NUMERIC,
      tracking_number TEXT,
      customer JSONB,
      items JSONB
    );
  `), 'create orders');
  console.log('DB init: orders table ready');

  console.log('DB init: creating reviews table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      name TEXT,
      product TEXT,
      rating INTEGER,
      date TEXT,
      text TEXT,
      visible BOOLEAN,
      verified_buyer BOOLEAN,
      user_id TEXT,
      user_email TEXT,
      user_name TEXT,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );
  `), 'create reviews');
  console.log('DB init: reviews table ready');

  await withDbTimeout(runQueryLogged(`
    ALTER TABLE reviews
      ADD COLUMN IF NOT EXISTS user_id TEXT,
      ADD COLUMN IF NOT EXISTS user_email TEXT,
      ADD COLUMN IF NOT EXISTS user_name TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
  `), 'add review metadata columns');

  console.log('DB init: creating offers table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      code TEXT,
      title TEXT,
      description TEXT,
      discount NUMERIC,
      active BOOLEAN,
      product_id TEXT,
      min_order_value NUMERIC
    );
  `), 'create offers');
  console.log('DB init: offers table ready');

  console.log('DB init: creating store_settings table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id SERIAL PRIMARY KEY,
      settings JSONB
    );
  `), 'create store_settings');
  console.log('DB init: store_settings ready');

  console.log('DB init: creating payment_settings table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS payment_settings (
      id SERIAL PRIMARY KEY,
      settings JSONB
    );
  `), 'create payment_settings');
  console.log('DB init: payment_settings ready');

  console.log('DB init: creating user_profiles table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      email TEXT PRIMARY KEY,
      profile JSONB
    );
  `), 'create user_profiles');
  console.log('DB init: user_profiles ready');

  console.log('DB init: creating admin_profile table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS admin_profile (
      id SERIAL PRIMARY KEY,
      profile JSONB
    );
  `), 'create admin_profile');
  console.log('DB init: admin_profile ready');

  console.log('DB init: creating product_types table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS product_types (
      id SERIAL PRIMARY KEY,
      type TEXT UNIQUE
    );
  `), 'create product_types');
  console.log('DB init: product_types ready');

  console.log('DB init: creating shipping_rules table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS shipping_rules (
      id SERIAL PRIMARY KEY,
      rules JSONB
    );
  `), 'create shipping_rules');
  console.log('DB init: shipping_rules ready');

  console.log('DB init: creating users table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      phone TEXT,
      password_hash TEXT,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `), 'create users');
  console.log('DB init: users table ready');

  console.log('DB init: creating password_reset_otps table');
  await withDbTimeout(runQueryLogged(`
    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      email TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      reset_token_hash TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_email ON password_reset_otps(LOWER(email));
  `), 'create password_reset_otps');
  console.log('DB init: password_reset_otps table ready');

  console.log('DB init: counting product types');
  const typeCount = await withDbTimeout(runQueryLogged('SELECT COUNT(*)::INTEGER AS count FROM product_types'), 'count product_types');
  if (typeCount.rows[0]?.count === 0) {
    console.log('DB init: inserting default product types');
    for (const type of defaultProductTypes) {
      await withDbTimeout(runQueryLogged('INSERT INTO product_types (type) VALUES ($1)', [type]), `insert product_type ${type}`);
    }
    console.log('DB init: default product types inserted');
  }

  console.log('DB init: checking admin credentials');
  const result = await withDbTimeout(runQueryLogged('SELECT id FROM admin_credentials LIMIT 1'), 'select admin_credentials');
  if (result.rowCount === 0) {
    console.log('DB init: inserting default admin credentials');
    const hashed = await bcrypt.hash(defaultCredentials.password, 10);
    await withDbTimeout(runQueryLogged(
      'INSERT INTO admin_credentials (email, password) VALUES ($1, $2)',
      [defaultCredentials.email, hashed]
    ), 'insert default admin credentials');
    console.log('DB init: default admin credentials inserted');
  }

  console.log('DB init: normalizing admin credentials');
  await withDbTimeout(normalizeAdminCredentials(), 'normalize admin credentials');
  console.log('DB init: product rows are managed exclusively through the admin API');
  console.log('DB init: all init steps completed');
  console.log('STARTUP: DATABASE INITIALIZATION COMPLETE');
    global.__dbInitialized = true;
}

async function ensureDataDirectory() {
  await fs.mkdir(dataDir, { recursive: true });
  console.log('Using JSON data store at:', dataDir);
}

async function ensureStore() {
  if (isPostgresEnabled) {
    return; // Database initialization is handled at startup
  }

  await ensureDataDirectory();
  await ensureJsonFile(dataFile, defaultCredentials);

  try {
    await fs.access(productsFile);
  } catch {
    await fs.writeFile(productsFile, JSON.stringify([], null, 2), 'utf8');
  }

  await ensureJsonFile(ordersFile, defaultOrders);
  await ensureJsonFile(reviewsFile, defaultReviews);
  await ensureJsonFile(offersFile, defaultOffers);
  await ensureJsonFile(storeSettingsFile, defaultStoreSettings);
  await ensureJsonFile(paymentSettingsFile, defaultPaymentSettings);
  await ensureJsonFile(userProfilesFile, {});
  await ensureJsonFile(adminProfileFile, defaultAdminProfile);
  await ensureJsonFile(productTypesFile, defaultProductTypes);
  await ensureJsonFile(shippingRulesFile, defaultShippingRules);
}

async function readCredentials() {
  if (isPostgresEnabled && pool) {
    const r = await runQueryLogged('SELECT email, password FROM admin_credentials ORDER BY id LIMIT 1');
    return r.rows[0] || defaultCredentials;
  }

  await ensureStore();
  const raw = await fs.readFile(dataFile, 'utf8');
  const credentials = JSON.parse(raw);
  const storedPassword = String(credentials.password || '');
  const isHashed = /^\$2[aby]\$/.test(storedPassword);
  if (storedPassword && !isHashed) {
    credentials.password = await bcrypt.hash(storedPassword, 10);
    await fs.writeFile(dataFile, JSON.stringify(credentials, null, 2), 'utf8');
  }
  return credentials;
}

async function writeCredentials(nextState) {
  // Normalize email and ensure password is hashed before storing
  const email = String(nextState.email || defaultCredentials.email).trim().toLowerCase();
  const password = String(nextState.password || '');
  const isHashed = password.startsWith('$2a$') || password.startsWith('$2b$') || password.startsWith('$2y$');
  const toStorePassword = isHashed ? password : await bcrypt.hash(password, 10);

  if (isPostgresEnabled && pool) {
    try {
      const r = await runQueryLogged(
        'UPDATE admin_credentials SET email = $1, password = $2, updated_at = NOW() WHERE id = (SELECT id FROM admin_credentials LIMIT 1);',
        [email, toStorePassword]
      );
      const rowCount = r.rowCount;

      if (rowCount === 0) {
        await runQueryLogged('INSERT INTO admin_credentials (email, password) VALUES ($1, $2)', [email, toStorePassword]);
      }

      return { ...nextState, email, password: toStorePassword };
    } catch (err) {
      console.error('Admin credential persistence failed.');
      throw err;
    }
  }

  await ensureStore();
  const out = { ...nextState, email, password: toStorePassword };
  await fs.writeFile(dataFile, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

async function normalizeAdminCredentials() {
  if (!isPostgresEnabled || !pool) return;
  let credentials;
  try {
    const r = await runQueryLogged('SELECT id, email, password FROM admin_credentials ORDER BY id LIMIT 1');
    credentials = r.rows[0];
    if (!credentials) return;
  } catch (err) {
    console.error('Admin credential initialization failed.');
    throw err;
  }

  const currentEmail = String(credentials.email || '').trim();
  const storedEmail = currentEmail.toLowerCase();
  const defaultEmail = String(defaultCredentials.email).trim().toLowerCase();
  const storedPassword = String(credentials.password || '');
  const isHashed = storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$');

  const passwordMatchesDefault = isHashed
    ? await bcrypt.compare(defaultCredentials.password, storedPassword)
    : storedPassword === defaultCredentials.password;

  const shouldNormalizeEmail = passwordMatchesDefault && storedEmail !== defaultEmail;
  const shouldHashPassword = !isHashed;

  if (!shouldNormalizeEmail && !shouldHashPassword) {
    return;
  }

  const hashedPassword = isHashed ? storedPassword : await bcrypt.hash(storedPassword, 10);
  const emailToStore = shouldNormalizeEmail ? defaultCredentials.email : currentEmail;

  try {
    await runQueryLogged('UPDATE admin_credentials SET email = $1, password = $2, updated_at = NOW() WHERE id = $3', [emailToStore, hashedPassword, credentials.id]);
  } catch (err) {
    console.error('Admin credential normalization failed.');
    throw err;
  }
}

async function passwordsMatch(storedPassword, providedPassword) {
  if (!storedPassword || !providedPassword) return false;
  const normalized = String(providedPassword);
  if (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$')) {
    return bcrypt.compare(normalized, storedPassword);
  }
  return normalized === storedPassword;
}

async function readProducts() {
  if (isPostgresEnabled && pool) {
    try {
      const { rows } = await pool.query('SELECT * FROM products ORDER BY name');
      return rows.map(normalizeProduct);
    } catch {
      console.error('Failed to read products from PostgreSQL.');
      throw new Error('Product data is unavailable.');
    }
  }

  await ensureStore();
  let raw;
  try {
    raw = await fs.readFile(productsFile, 'utf8');
  } catch {
    console.error('Product file is unavailable.');
    throw new Error('Product data is unavailable.');
  }

  try {
    const products = JSON.parse(raw);
    return Array.isArray(products) ? products.map(normalizeProduct) : [];
  } catch {
    console.error('Product file contains invalid JSON.');
    throw new Error('Product data is unavailable.');
  }
}

async function writeProduct(product) {
  if (isPostgresEnabled && pool) {
    try {
      await pool.query(productInsertQuery, productRowParams(product));
      return product;
    } catch (error) {
      console.error('Failed to persist products to PostgreSQL.');
      throw error;
    }
  }

  await ensureStore();
  const products = await readProducts();
  const normalizedProduct = normalizeProduct(product);
  const existingIndex = products.findIndex((item) => item.id === normalizedProduct.id);
  if (existingIndex >= 0) {
    products[existingIndex] = normalizedProduct;
  } else {
    products.push(normalizedProduct);
  }
  await writeJsonFile(productsFile, products);
  return normalizedProduct;
}

async function writeProducts(nextProducts) {
  await ensureStore();
  const normalizedProducts = nextProducts.map(normalizeProduct);
  await writeJsonFile(productsFile, normalizedProducts);
  return normalizedProducts;
}

async function ensureJsonFile(filePath, defaultValue) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
  }
}

async function readJsonFile(filePath, defaultValue) {
  await ensureJsonFile(filePath, defaultValue);
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

async function writeJsonFile(filePath, nextValue) {
  await ensureJsonFile(filePath, nextValue);
  await fs.writeFile(filePath, JSON.stringify(nextValue, null, 2), 'utf8');
  return nextValue;
}

const defaultOrders = [];
const defaultReviews = [];
const defaultOffers = [];
const defaultStoreSettings = {};
const defaultPaymentSettings = {
  qrImage: 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=upi://pay?pa=konasemaruchulu@upi%26pn=Konasema%20Ruchulu%20Pickles',
  upiId: 'konasemaruchulu@upi',
  phone: '+91 8885473903',
  enableCOD: true,
  enableUPI: true,
  enableScanner: true,
  scannerNote: 'Scan the QR code using Google Pay, PhonePe, Paytm, or BHIM UPI to complete payment.',
  instructions: 'After paying, take a screenshot and enter your transaction UTR reference number.'
};
const defaultAdminProfile = {};
const defaultProductTypes = ['Pickles', 'Podis', 'Non-Veg Pickles', 'Sweets & Snacks'];

const defaultShippingRules = {
  defaultCharge: 80,
  states: {
    'Andhra Pradesh': {
      defaultCharge: 70,
      districts: {
        'East Godavari':  { charge: 50, active: true },
        'West Godavari':  { charge: 50, active: true },
        'Krishna':        { charge: 60, active: true },
        'Guntur':         { charge: 60, active: true },
        'Visakhapatnam':  { charge: 70, active: true },
        'Srikakulam':     { charge: 70, active: true },
        'Vizianagaram':   { charge: 70, active: true },
        'Kurnool':        { charge: 70, active: true },
        'Kadapa':         { charge: 70, active: true },
        'Nellore':        { charge: 65, active: true },
        'Chittoor':       { charge: 70, active: true },
        'Prakasam':       { charge: 65, active: true },
        'Eluru':          { charge: 55, active: true },
        'Bapatla':        { charge: 60, active: true },
        'Palnadu':        { charge: 65, active: true },
        'NTR':            { charge: 60, active: true },
        'Konaseema':      { charge: 55, active: true },
        'Anakapalli':     { charge: 65, active: true },
        'Alluri Sitharama Raju': { charge: 75, active: true },
        'Sri Potti Sriramulu Nellore': { charge: 65, active: true }
      }
    },
    'Telangana': {
      defaultCharge: 65,
      districts: {
        'Hyderabad':       { charge: 60, active: true },
        'Rangareddy':      { charge: 60, active: true },
        'Medchal Malkajgiri': { charge: 60, active: true },
        'Warangal':        { charge: 70, active: true },
        'Karimnagar':      { charge: 70, active: true },
        'Nizamabad':       { charge: 70, active: true },
        'Khammam':         { charge: 70, active: true },
        'Nalgonda':        { charge: 70, active: true },
        'Mahabubnagar':    { charge: 70, active: true },
        'Adilabad':        { charge: 75, active: true },
        'Siddipet':        { charge: 70, active: true },
        'Sangareddy':      { charge: 65, active: true },
        'Mancherial':      { charge: 75, active: true },
        'Jagtial':         { charge: 75, active: true },
        'Peddapalli':      { charge: 75, active: true },
        'Suryapet':        { charge: 70, active: true },
        'Bhadradri Kothagudem': { charge: 70, active: true },
        'Mulugu':          { charge: 75, active: true },
        'Jayashankar Bhupalpally': { charge: 75, active: true },
        'Wanaparthy':      { charge: 70, active: true }
      }
    }
  }
};

async function readOrders() {
  if (isPostgresEnabled && pool) {
    try {
      
      const { rows } = await pool.query('SELECT * FROM orders ORDER BY date DESC');
      return rows.map((row) => ({
        id: row.id,
        date: row.date,
        status: row.status,
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method,
        totalAmount: Number(row.total_amount),
        trackingNumber: row.tracking_number,
        customer: row.customer || {},
        items: row.items || [],
      }));
    } catch {
      console.error('Failed to read orders from PostgreSQL.');
      throw new Error('Order data is unavailable.');
    }
  }
  return readJsonFile(ordersFile, defaultOrders);
}

function deepParseJsonValue(value) {
  let result = value;
  while (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (parsed === result) break;
      result = parsed;
    } catch {
      break;
    }
  }
  return result;
}

async function writeOrders(nextOrders) {
  if (isPostgresEnabled && pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM orders');
      for (const order of nextOrders) {
        try {
          const customerValue = deepParseJsonValue(order.customer || {});
          const itemsValue = deepParseJsonValue(order.items || []);
          const customerJson = typeof customerValue === 'string' ? JSON.parse(customerValue) : customerValue;
          const itemsJson = typeof itemsValue === 'string' ? JSON.parse(itemsValue) : itemsValue;

          await client.query(
            `INSERT INTO orders (id, date, status, payment_status, payment_method, total_amount, tracking_number, customer, items)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              order.id,
              order.date,
              order.status,
              order.paymentStatus,
              order.paymentMethod,
              order.totalAmount,
              order.trackingNumber,
              customerJson,
              itemsJson,
            ]
          );
        } catch {
          console.error('Failed to persist an order row.');
          throw new Error('Order persistence failed.');
        }
      }
      await client.query('COMMIT');
      return nextOrders;
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        console.error('Order persistence rollback failed.');
      }
      console.error('Order persistence failed.');
      throw new Error('Order persistence failed.');
    } finally {
      client.release();
    }
  }

  return writeJsonFile(ordersFile, nextOrders);
}

async function readReviews() {
  if (isPostgresEnabled && pool) {
    
    const { rows } = await pool.query('SELECT * FROM reviews ORDER BY date DESC');
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      product: row.product,
      rating: row.rating,
      date: row.date,
      text: row.text,
      visible: row.visible,
      verifiedBuyer: row.verified_buyer,
      user_id: row.user_id,
      user_email: row.user_email,
      user_name: row.user_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }
  return readJsonFile(reviewsFile, defaultReviews);
}

async function writeReviews(nextReviews) {
  if (isPostgresEnabled && pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM reviews');
      for (const review of nextReviews) {
        await client.query(
          `INSERT INTO reviews (id, name, product, rating, date, text, visible, verified_buyer, user_id, user_email, user_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            review.id,
            review.name,
            review.product,
            review.rating,
            review.date,
            review.text,
            review.visible,
            review.verifiedBuyer,
            review.user_id || null,
            review.user_email || null,
            review.user_name || null,
            review.created_at || null,
            review.updated_at || null,
          ]
        );
      }
      await client.query('COMMIT');
      return nextReviews;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return writeJsonFile(reviewsFile, nextReviews);
}

async function readOffers() {
  if (isPostgresEnabled && pool) {
    
    const { rows } = await pool.query('SELECT * FROM offers ORDER BY id');
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      description: row.description,
      discount: Number(row.discount),
      active: row.active,
      productId: row.product_id,
      minOrderValue: Number(row.min_order_value),
    }));
  }
  return readJsonFile(offersFile, defaultOffers);
}

async function writeOffers(nextOffers) {
  if (isPostgresEnabled && pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM offers');
      for (const offer of nextOffers) {
        await client.query(
          `INSERT INTO offers (id, code, title, description, discount, active, product_id, min_order_value)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            offer.id,
            offer.code,
            offer.title,
            offer.description,
            offer.discount,
            offer.active,
            offer.productId,
            offer.minOrderValue,
          ]
        );
      }
      await client.query('COMMIT');
      return nextOffers;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return writeJsonFile(offersFile, nextOffers);
}

async function readStoreSettings() {
  if (isPostgresEnabled && pool) {
    
    const { rows } = await pool.query('SELECT settings FROM store_settings ORDER BY id LIMIT 1');
    return rows[0]?.settings || defaultStoreSettings;
  }
  return readJsonFile(storeSettingsFile, defaultStoreSettings);
}

async function writeStoreSettings(nextSettings) {
  if (isPostgresEnabled && pool) {
    
    const { rowCount } = await pool.query(
      'UPDATE store_settings SET settings = $1 WHERE id = (SELECT id FROM store_settings LIMIT 1)',
      [nextSettings]
    );
    if (rowCount === 0) {
      await pool.query('INSERT INTO store_settings (settings) VALUES ($1)', [nextSettings]);
    }
    return nextSettings;
  }
  return writeJsonFile(storeSettingsFile, nextSettings);
}

async function readPaymentSettings() {
  if (isPostgresEnabled && pool) {
    
    const { rows } = await pool.query('SELECT settings FROM payment_settings ORDER BY id LIMIT 1');
    return { ...defaultPaymentSettings, ...(rows[0]?.settings || {}) };
  }
  const settings = await readJsonFile(paymentSettingsFile, defaultPaymentSettings);
  return { ...defaultPaymentSettings, ...(settings || {}) };
}

async function writePaymentSettings(nextSettings) {
  if (isPostgresEnabled && pool) {
    
    const { rowCount } = await pool.query(
      'UPDATE payment_settings SET settings = $1 WHERE id = (SELECT id FROM payment_settings LIMIT 1)',
      [nextSettings]
    );
    if (rowCount === 0) {
      await pool.query('INSERT INTO payment_settings (settings) VALUES ($1)', [nextSettings]);
    }
    return nextSettings;
  }
  return writeJsonFile(paymentSettingsFile, nextSettings);
}

async function readAdminProfile() {
  if (isPostgresEnabled && pool) {
    
    const { rows } = await pool.query('SELECT profile FROM admin_profile ORDER BY id LIMIT 1');
    return rows[0]?.profile || defaultAdminProfile;
  }
  return readJsonFile(adminProfileFile, defaultAdminProfile);
}

async function writeAdminProfile(nextProfile) {
  if (isPostgresEnabled && pool) {
    
    const { rowCount } = await pool.query(
      'UPDATE admin_profile SET profile = $1 WHERE id = (SELECT id FROM admin_profile LIMIT 1)',
      [nextProfile]
    );
    if (rowCount === 0) {
      await pool.query('INSERT INTO admin_profile (profile) VALUES ($1)', [nextProfile]);
    }
    return nextProfile;
  }
  return writeJsonFile(adminProfileFile, nextProfile);
}

async function readShippingRules() {
  if (isPostgresEnabled && pool) {
    const { rows } = await pool.query('SELECT rules FROM shipping_rules ORDER BY id LIMIT 1');
    return rows[0]?.rules || defaultShippingRules;
  }
  return readJsonFile(shippingRulesFile, defaultShippingRules);
}

async function writeShippingRules(nextRules) {
  if (isPostgresEnabled && pool) {
    const { rowCount } = await pool.query(
      'UPDATE shipping_rules SET rules = $1 WHERE id = (SELECT id FROM shipping_rules LIMIT 1)',
      [nextRules]
    );
    if (rowCount === 0) {
      await pool.query('INSERT INTO shipping_rules (rules) VALUES ($1)', [nextRules]);
    }
    return nextRules;
  }
  return writeJsonFile(shippingRulesFile, nextRules);
}

/**
 * Normalize a location name for fuzzy matching:
 * lowercase, trim, remove punctuation, collapse spaces.
 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Find a district key in a districts map using normalized matching.
 * Returns the matched key or null.
 */
function findDistrictKey(districts, targetDistrict) {
  if (!districts || !targetDistrict) return null;
  const normalizedTarget = normalizeName(targetDistrict);
  // 1. Exact normalized match
  for (const key of Object.keys(districts)) {
    if (normalizeName(key) === normalizedTarget) return key;
  }
  // 2. Partial match: target contains key or key contains target
  for (const key of Object.keys(districts)) {
    const normKey = normalizeName(key);
    if (normalizedTarget.includes(normKey) || normKey.includes(normalizedTarget)) return key;
  }
  return null;
}

/**
 * Find a state key in the states map using normalized matching.
 */
function findStateKey(states, targetState) {
  if (!states || !targetState) return null;
  const normalizedTarget = normalizeName(targetState);
  for (const key of Object.keys(states)) {
    if (normalizeName(key) === normalizedTarget) return key;
  }
  // Partial match
  for (const key of Object.keys(states)) {
    const normKey = normalizeName(key);
    if (normalizedTarget.includes(normKey) || normKey.includes(normalizedTarget)) return key;
  }
  return null;
}

/**
 * Calculate shipping charge.
 * Priority: district rule (if active) → state default → global default
 */
function calculateShippingCharge(state, district, rules) {
  const r = rules || defaultShippingRules;
  const globalDefault = Number(r.defaultCharge) || 80;

  const stateKey = findStateKey(r.states, state);
  if (!stateKey) return globalDefault;

  const stateData = r.states[stateKey];
  const stateDefault = Number(stateData?.defaultCharge) || globalDefault;

  const districtKey = findDistrictKey(stateData?.districts, district);
  if (!districtKey) return stateDefault;

  const districtData = stateData.districts[districtKey];
  if (!districtData || districtData.active === false) return stateDefault;

  return Number(districtData.charge) || stateDefault;
}

async function readProductTypes() {
  if (isPostgresEnabled && pool) {
    
    const { rows } = await pool.query('SELECT type FROM product_types ORDER BY id');
    return rows.map((row) => row.type);
  }
  return readJsonFile(productTypesFile, defaultProductTypes);
}

async function writeProductTypes(types) {
  if (isPostgresEnabled && pool) {
    
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM product_types');
      for (const type of types) {
        await pool.query('INSERT INTO product_types (type) VALUES ($1)', [type]);
      }
      await pool.query('COMMIT');
      return types;
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  return writeJsonFile(productTypesFile, types);
}

async function readUserProfile(email) {
  let profile;
  if (isPostgresEnabled && pool) {
    const { rows } = await pool.query('SELECT profile FROM user_profiles WHERE email = $1', [email]);
    profile = rows[0]?.profile;
  } else {
    const data = await readJsonFile(userProfilesFile, {});
    profile = data[email];
  }
  return toPublicUserProfile(profile || {}, email);
}

async function writeUserProfile(email, profile) {
  const currentProfile = await readUserProfile(email);
  const safeProfile = toPublicUserProfile({ ...currentProfile, ...profile }, email);
  if (isPostgresEnabled && pool) {
    const { rowCount } = await pool.query(
      'UPDATE user_profiles SET profile=$1 WHERE email=$2',
      [safeProfile, email]
    );
    if (rowCount === 0) {
      await pool.query('INSERT INTO user_profiles (email, profile) VALUES ($1, $2)', [email, safeProfile]);
    }
    return safeProfile;
  }
  const data = await readJsonFile(userProfilesFile, {});
  data[email] = { ...data[email], ...safeProfile };
  await writeJsonFile(userProfilesFile, data);
  return toPublicUserProfile(data[email], email);
}

async function readCustomers() {
  const orders = await readOrders();
  const customersMap = {};
  orders.forEach((order) => {
    const key = order.customer?.email || order.customer?.phone || order.customer?.name || 'guest';
    if (!customersMap[key]) {
      customersMap[key] = {
        name: order.customer?.name || 'Customer',
        email: order.customer?.email || 'N/A',
        phone: order.customer?.phone || 'N/A',
        totalOrders: 0,
        lastOrder: order.date,
      };
    }
    customersMap[key].totalOrders += 1;
    if (new Date(order.date) > new Date(customersMap[key].lastOrder)) {
      customersMap[key].lastOrder = order.date;
    }
  });
  return Object.values(customersMap);
}

const app = express();

app.set('trust proxy', 1);

const allowedOrigins = new Set([
  'https://ruchira-pickels.vercel.app',
  ...(process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:3000']),
  ...(process.env.FRONTEND_URLS || process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
]);

const createRateLimiter = (windowMs, limit, message) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: message },
});
const loginRateLimiter = createRateLimiter(15 * 60 * 1000, 10, 'Too many login attempts. Please try again later.');
const otpRequestRateLimiter = createRateLimiter(60 * 60 * 1000, 3, 'Too many verification-code requests. Please try again later.');
const otpVerifyRateLimiter = createRateLimiter(15 * 60 * 1000, 10, 'Too many verification attempts. Please request a new code later.');
const passwordResetRateLimiter = createRateLimiter(15 * 60 * 1000, 5, 'Too many password reset attempts. Please try again later.');
const orderRateLimiter = createRateLimiter(15 * 60 * 1000, 10, 'Too many order requests. Please try again later.');
const pinLookupRateLimiter = createRateLimiter(15 * 60 * 1000, 30, 'Too many PIN lookups. Please try again later.');

const isValidEmail = (value) => (
  typeof value === 'string' &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
);
const isValidPassword = (value, minimumLength = 8) => (
  typeof value === 'string' &&
  value.length >= minimumLength &&
  Buffer.byteLength(value, 'utf8') <= 72
);
const containsControlCharacters = (value) => (
  typeof value === 'string' &&
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })
);
const isValidName = (value, maximumLength = 100) => (
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim().length <= maximumLength &&
  !containsControlCharacters(value)
);
const isValidPhone = (value) => (
  typeof value === 'string' &&
  value.length <= 32 &&
  /^[+()\d\s.-]+$/.test(value) &&
  value.replace(/\D/g, '').length >= 7 &&
  value.replace(/\D/g, '').length <= 15
);
const isValidResourceId = (value) => (
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9_-]+$/.test(value)
);
const isNonNegativeAmount = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
const isSafeImageUrl = (value) => (
  typeof value === 'string' &&
  value.length <= 2_000_000 &&
  (!value || (value.startsWith('/') && !value.startsWith('//')) ||
    /^https:\/\/[^\s]+$/i.test(value) ||
    /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value))
);
const isBoundedJsonData = (value, depth = 0) => {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 750_000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isBoundedJsonData(item, depth + 1));
  return typeof value === 'object' && Object.keys(value).length <= 100 &&
    Object.values(value).every((item) => isBoundedJsonData(item, depth + 1));
};
const isValidSettingsObject = (value) => (
  !!value && typeof value === 'object' && !Array.isArray(value) && isBoundedJsonData(value)
);
const validateProductInput = (product, isUpdate = false) => {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return 'Invalid product data.';
  if (!isValidName(product.name, 150)) return 'Enter a valid product name.';
  if (typeof product.category !== 'string' || !product.category.trim() || product.category.length > 100) return 'Enter a valid product category.';
  if (typeof product.productType !== 'string' || !product.productType.trim() || product.productType.length > 100) return 'Enter a valid product type.';
  if (product.id !== undefined && product.id !== '' && !isValidResourceId(String(product.id))) return 'Invalid product ID.';
  if (isUpdate && product.id !== undefined && String(product.id) !== '') return 'Product ID cannot be changed.';
  if (product.quantityType !== undefined && (typeof product.quantityType !== 'string' || product.quantityType.length > 40)) return 'Enter a valid quantity type.';
  if (product.pricePerUnit !== undefined && !isNonNegativeAmount(product.pricePerUnit)) return 'Enter a valid product price.';
  if (product.discountPrice !== undefined && !isNonNegativeAmount(product.discountPrice)) return 'Enter a valid discount price.';
  if (product.bulkPrice !== undefined && !isNonNegativeAmount(product.bulkPrice)) return 'Enter a valid bulk price.';
  if (product.stockQuantity !== undefined && (!Number.isInteger(Number(product.stockQuantity)) || Number(product.stockQuantity) < 0 || Number(product.stockQuantity) > 1_000_000)) return 'Enter a valid stock quantity.';
  for (const key of ['description', 'ingredients', 'shelfLife', 'spiceLevel']) {
    if (product[key] !== undefined && (typeof product[key] !== 'string' || product[key].length > (key === 'description' || key === 'ingredients' ? 10_000 : 200))) return `Enter valid ${key.toLowerCase()} information.`;
  }
  for (const key of ['inStock', 'bestSeller', 'newArrival', 'visible']) {
    if (product[key] !== undefined && typeof product[key] !== 'boolean') return `Invalid ${key} value.`;
  }
  if (product.weights !== undefined && (
    !Array.isArray(product.weights) || product.weights.length > 50 ||
    product.weights.some((weight) => (
      !weight || typeof weight !== 'object' || Array.isArray(weight) ||
      typeof (weight.weight ?? weight.label) !== 'string' ||
      !(weight.weight ?? weight.label).trim() || (weight.weight ?? weight.label).length > 64 ||
      !Number.isFinite(Number(weight.price)) || Number(weight.price) <= 0
    ))
  )) return 'Enter valid product options and prices.';
  if (product.variants !== undefined && !Array.isArray(product.variants)) return 'Product options must be an array.';
  if (product.image !== undefined && !isSafeImageUrl(product.image)) return 'Enter a valid product image URL.';
  if (product.additionalImages !== undefined && (
    !Array.isArray(product.additionalImages) || product.additionalImages.length > 20 ||
    product.additionalImages.some((image) => !isSafeImageUrl(image))
  )) return 'Enter valid additional product images.';
  if (!(Number(product.pricePerUnit) > 0) && !(Array.isArray(product.weights) && product.weights.length > 0)) {
    return 'Add at least one product price.';
  }
  return null;
};
const toPublicUserProfile = (profile, email) => ({
  name: typeof profile?.name === 'string' ? profile.name.slice(0, 100) : '',
  email,
  phone: typeof profile?.phone === 'string' ? profile.phone.slice(0, 32) : '',
  addresses: Array.isArray(profile?.addresses)
    ? profile.addresses.slice(0, 20).map((address) => ({
      id: String(address?.id || '').slice(0, 128),
      label: typeof address?.label === 'string' ? address.label.slice(0, 40) : '',
      name: typeof address?.name === 'string' ? address.name.slice(0, 100) : '',
      phone: typeof address?.phone === 'string' ? address.phone.slice(0, 32) : '',
      street: typeof address?.street === 'string' ? address.street.slice(0, 500) : '',
      city: typeof address?.city === 'string' ? address.city.slice(0, 100) : '',
      state: typeof address?.state === 'string' ? address.state.slice(0, 100) : '',
      pincode: typeof address?.pincode === 'string' ? address.pincode.slice(0, 6) : '',
      landmark: typeof address?.landmark === 'string' ? address.landmark.slice(0, 200) : '',
    }))
    : [],
  wishlist: Array.isArray(profile?.wishlist)
    ? profile.wishlist.filter((id) => isValidResourceId(String(id))).slice(0, 500).map(String)
    : [],
});
const toPublicReview = (review) => ({
  id: String(review?.id || ''),
  name: typeof review?.name === 'string' ? review.name.slice(0, 100) : '',
  product: typeof review?.product === 'string' ? review.product.slice(0, 100) : '',
  rating: Number(review?.rating) || 0,
  date: typeof review?.date === 'string' ? review.date.slice(0, 100) : '',
  text: typeof review?.text === 'string' ? review.text.slice(0, 2000) : '',
  visible: review?.visible !== false,
  verifiedBuyer: review?.verifiedBuyer === true,
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      const error = new Error('Origin is not allowed by CORS');
      error.status = 403;
      return callback(error);
    },
    credentials: true,
  })
);

app.use(helmet());

app.put(
  '/api/store-settings/logo',
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '500kb' }),
  requireAdmin,
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Choose a PNG, JPEG, or WebP logo image.' });
      }

      const image = req.body;
      const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const isPng = contentType === 'image/png' && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isJpeg = contentType === 'image/jpeg' && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
      const isWebp = contentType === 'image/webp' &&
        image.toString('ascii', 0, 4) === 'RIFF' &&
        image.toString('ascii', 8, 12) === 'WEBP';
      if (!isPng && !isJpeg && !isWebp) {
        return res.status(400).json({ error: 'The selected file is not a valid PNG, JPEG, or WebP image.' });
      }

      const settings = await readStoreSettings();
      const logoUrl = `data:${contentType};base64,${image.toString('base64')}`;
      await writeStoreSettings({ ...settings, logoUrl });
      res.json({ logoUrl });
    } catch {
      console.error('Failed to upload store logo.');
      res.status(500).json({ error: 'Unable to save the store logo.' });
    }
  }
);

app.use(express.json({ limit: '1mb', strict: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export { app };

app.get('/api/admin-credentials', requireAdmin, async (_req, res) => {
  try {
    const credentials = await readCredentials();
    res.json({ email: credentials.email });
  } catch {
    console.error('Failed to read admin credentials.');
    res.status(500).json({ error: 'Unable to read admin credentials.' });
  }
});

// Admin login endpoint
app.post('/api/admin/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !isValidPassword(password, 1)) {
      return res.status(400).json({ error: 'A valid email and password are required.' });
    }
    const creds = await readCredentials();
    const inputEmail = String(email).trim().toLowerCase();
    const storedEmail = String(creds.email || '').trim().toLowerCase();
    const storedPass = String(creds.password || '');

    let ok = false;
    if (storedEmail === inputEmail) {
      if (storedPass.startsWith('$2')) {
        ok = await bcrypt.compare(password, storedPass);
      } else {
        ok = password === storedPass;
        if (ok) {
          await writeCredentials({ email: creds.email, password });
        }
      }
    }

    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const authVersion = crypto.createHmac('sha256', JWT_SECRET).update(String(creds.password || '')).digest('hex');
    const token = generateToken({ id: 'admin', email: creds.email, name: 'Administrator', isAdmin: true, role: 'admin', authVersion });
    const out = { token, email: creds.email, name: 'Administrator' };
    res.json(out);
  } catch {
    console.error('Admin login failed.');
    return res.status(500).json({ error: 'Unable to authenticate' });
  }
});

const adminResetResponse = {
  success: true,
  message: 'If an account exists for this email, a verification code has been sent.',
};

app.post('/api/admin/forgot-password', otpRequestRateLimiter, async (req, res) => {
  try {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'A valid email address is required.' });

    const credentials = await readCredentials();
    const adminEmail = String(credentials.email || '').trim().toLowerCase();
    if (cleanEmail !== adminEmail) {
      return res.json(adminResetResponse);
    }

    if (isPostgresEnabled && pool) {
      const recent = await pool.query(
        "SELECT created_at FROM password_reset_otps WHERE user_id = 'admin' AND LOWER(email) = $1 AND created_at > NOW() - INTERVAL '60 seconds' LIMIT 1",
        [cleanEmail]
      );
      if (recent.rows.length > 0) return res.json(adminResetResponse);
    } else if (credentials.pending_otp_created &&
        Date.now() - new Date(credentials.pending_otp_created).getTime() < 60 * 1000) {
      return res.json(adminResetResponse);
    }

    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const otpHash = await bcrypt.hash(otpCode, 10);
    const otpId = `admin_otp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    if (isPostgresEnabled && pool) {
      await pool.query("DELETE FROM password_reset_otps WHERE user_id = 'admin' AND LOWER(email) = $1", [cleanEmail]);
      await pool.query(
        'INSERT INTO password_reset_otps (id, user_id, email, otp_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [otpId, 'admin', cleanEmail, otpHash, expiresAt]
      );
    } else {
      await writeCredentials({
        ...credentials,
        pending_otp_id: otpId,
        pending_otp_hash: otpHash,
        pending_otp_expires: expiresAt.toISOString(),
        pending_otp_created: new Date().toISOString(),
        pending_otp_attempts: 0,
      });
    }

    const emailResult = await sendPasswordResetOTP(cleanEmail, otpCode);
    console.info('Admin password reset dispatch result', {
      result: emailResult.reason,
      status: emailResult.status || null,
    });
    return res.json(adminResetResponse);
  } catch {
    console.error('Admin password reset request failed.');
    return res.status(500).json({ error: 'Unable to process password reset request.' });
  }
});

app.post('/api/admin/verify-reset-otp', otpVerifyRateLimiter, async (req, res) => {
  try {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    const cleanOtp = String(req.body?.otp || '').trim();
    if (!isValidEmail(cleanEmail) || !/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({ error: 'Email and 6-digit verification code are required' });
    }

    if (!isPostgresEnabled || !pool) {
      const credentials = await readCredentials();
      const attempts = Number(credentials.pending_otp_attempts) || 0;
      if (cleanEmail !== String(credentials.email || '').trim().toLowerCase() ||
          !credentials.pending_otp_hash || !credentials.pending_otp_expires ||
          new Date(credentials.pending_otp_expires) <= new Date() || attempts >= 5) {
        return res.status(400).json({ error: 'Invalid or expired verification code.' });
      }
      const nextAttempts = attempts + 1;
      if (!(await bcrypt.compare(cleanOtp, credentials.pending_otp_hash))) {
        await writeCredentials({ ...credentials, pending_otp_attempts: nextAttempts });
        const remaining = Math.max(5 - nextAttempts, 0);
        return res.status(400).json({
          error: remaining > 0
            ? `Incorrect verification code. ${remaining} attempts remaining.`
            : 'Maximum verification attempts exceeded. Please request a new code.',
        });
      }
      const rawResetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = await bcrypt.hash(rawResetToken, 10);
      const resetTokenId = credentials.pending_otp_id;
      const updatedCredentials = {
        ...credentials,
        reset_token_id: resetTokenId,
        reset_token_hash: resetTokenHash,
        reset_token_expires: credentials.pending_otp_expires,
      };
      for (const key of ['pending_otp_id', 'pending_otp_hash', 'pending_otp_expires', 'pending_otp_created', 'pending_otp_attempts']) {
        delete updatedCredentials[key];
      }
      await writeCredentials(updatedCredentials);
      return res.json({ success: true, resetToken: `${resetTokenId}:${rawResetToken}` });
    }

    const { rows } = await pool.query(
      `UPDATE password_reset_otps
       SET attempts = attempts + 1
       WHERE id = (
         SELECT id FROM password_reset_otps
         WHERE user_id = 'admin' AND LOWER(email) = $1 AND verified = FALSE
           AND expires_at > NOW() AND attempts < max_attempts
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE
       )
       RETURNING id, otp_hash, attempts, max_attempts`,
      [cleanEmail]
    );
    const record = rows[0];
    if (!record) return res.status(400).json({ error: 'Invalid or expired verification code.' });
    if (!(await bcrypt.compare(cleanOtp, record.otp_hash))) {
      const remaining = Math.max(record.max_attempts - record.attempts, 0);
      return res.status(400).json({
        error: remaining > 0
          ? `Incorrect verification code. ${remaining} attempts remaining.`
          : 'Maximum verification attempts exceeded. Please request a new code.',
      });
    }

    const rawResetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = await bcrypt.hash(rawResetToken, 10);
    const used = await pool.query(
      'UPDATE password_reset_otps SET verified = TRUE, reset_token_hash = $1 WHERE id = $2 AND verified = FALSE RETURNING id',
      [resetTokenHash, record.id]
    );
    if (used.rowCount !== 1) return res.status(400).json({ error: 'Invalid or expired verification code.' });
    return res.json({ success: true, resetToken: `${record.id}:${rawResetToken}` });
  } catch {
    console.error('Admin verification-code check failed.');
    return res.status(500).json({ error: 'Unable to verify verification code.' });
  }
});

app.post('/api/admin/reset-password', passwordResetRateLimiter, async (req, res) => {
  try {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    const newPassword = String(req.body?.newPassword || '');
    const resetToken = String(req.body?.resetToken || '');
    if (!isValidEmail(cleanEmail) || !isValidPassword(newPassword) || !resetToken) {
      return res.status(400).json({ error: 'A valid email, reset token, and password of at least 8 characters are required.' });
    }
    const parts = resetToken.split(':');
    if (parts.length !== 2 || !isValidResourceId(parts[0]) || !/^[a-f0-9]{64}$/i.test(parts[1])) {
      return res.status(400).json({ error: 'Invalid reset session.' });
    }

    if (!isPostgresEnabled || !pool) {
      const credentials = await readCredentials();
      if (cleanEmail !== String(credentials.email || '').trim().toLowerCase() ||
          parts[0] !== credentials.reset_token_id ||
          !credentials.reset_token_hash || !credentials.reset_token_expires ||
          new Date(credentials.reset_token_expires) <= new Date() ||
          !(await bcrypt.compare(parts[1], credentials.reset_token_hash))) {
        return res.status(400).json({ error: 'Reset session expired or invalid.' });
      }
      const updatedCredentials = { ...credentials, password: newPassword };
      for (const key of ['reset_token_id', 'reset_token_hash', 'reset_token_expires']) delete updatedCredentials[key];
      await writeCredentials(updatedCredentials);
      return res.json({ success: true, message: 'Password updated successfully. Please log in.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        "SELECT id, reset_token_hash FROM password_reset_otps WHERE id = $1 AND user_id = 'admin' AND LOWER(email) = $2 AND verified = TRUE AND expires_at > NOW() FOR UPDATE",
        [parts[0], cleanEmail]
      );
      const record = rows[0];
      if (!record?.reset_token_hash || !(await bcrypt.compare(parts[1], record.reset_token_hash))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Reset session expired or invalid.' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      const updated = await client.query(
        'UPDATE admin_credentials SET password = $1, updated_at = NOW() WHERE LOWER(email) = $2',
        [passwordHash, cleanEmail]
      );
      if (updated.rowCount !== 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Reset session expired or invalid.' });
      }
      await client.query('DELETE FROM password_reset_otps WHERE id = $1', [record.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return res.json({ success: true, message: 'Password updated successfully. Please log in.' });
  } catch {
    console.error('Admin password reset failed.');
    return res.status(500).json({ error: 'Unable to reset password.' });
  }
});

// Protect admin updates — require admin JWT
function requireAdmin(req, res, next) {
  authenticateToken(req, res, async () => {
    try {
      if (!await isCurrentAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
      return next();
    } catch {
      return res.status(503).json({ error: 'Admin authorization is temporarily unavailable.' });
    }
  });
}

async function isCurrentAdmin(user) {
  if (!user?.isAdmin || user.role !== 'admin') return false;
  const credentials = await readCredentials();
  const credentialVersion = crypto.createHmac('sha256', JWT_SECRET).update(String(credentials.password || '')).digest('hex');
  const tokenVersion = String(user.authVersion || '');
  const sameVersion = /^[a-f0-9]{64}$/i.test(tokenVersion) &&
    crypto.timingSafeEqual(Buffer.from(tokenVersion, 'hex'), Buffer.from(credentialVersion, 'hex'));
  return sameVersion &&
    String(credentials.email || '').trim().toLowerCase() === String(user.email || '').trim().toLowerCase();
}

function authenticateOwnerOrAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (req.user?.isAdmin) return requireAdmin(req, res, next);
    return next();
  });
}

app.post('/api/admin-credentials/password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const credentials = await readCredentials();

    if (!isValidPassword(currentPassword, 1) || !isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'A valid current password and a new password of at least 8 characters are required.' });
    }

    const ok = await passwordsMatch(credentials.password, currentPassword);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    await writeCredentials({ ...credentials, password: newPassword });
    res.json({ success: true });
  } catch {
    console.error('Failed to update admin password.');
    res.status(500).json({ error: 'Unable to update admin password.' });
  }
});

app.post('/api/admin-credentials/email', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newEmail } = req.body || {};
    const credentials = await readCredentials();

    if (!isValidPassword(currentPassword, 1) || !isValidEmail(newEmail)) {
      return res.status(400).json({ error: 'A valid current password and a new email address are required.' });
    }

    const ok = await passwordsMatch(credentials.password, currentPassword);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const updated = await writeCredentials({ ...credentials, email: newEmail.trim().toLowerCase() });
    res.json({ success: true, email: updated.email });
  } catch {
    console.error('Failed to update admin email.');
    res.status(500).json({ error: 'Unable to update admin email.' });
  }
});

app.get('/api/products', optionalAuthenticateToken, async (req, res) => {
  try {
    const products = await readProducts();
    if (req.user?.isAdmin && !await isCurrentAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(req.user?.isAdmin ? products : products.filter((product) => product.visible !== false));
  } catch {
    console.error('Failed to read products.');
    res.status(500).json({ error: 'Unable to read products.' });
  }
});

app.get('/api/products/:id', optionalAuthenticateToken, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID.' });
    const isAdmin = req.user?.isAdmin && await isCurrentAdmin(req.user);
    if (req.user?.isAdmin && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const products = await readProducts();
    const product = products.find((item) => String(item.id) === req.params.id);
    if (!product || (product.visible === false && !isAdmin)) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json(product);
  } catch {
    console.error('Failed to read product.');
    res.status(500).json({ error: 'Unable to read product.' });
  }
});

app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const product = req.body || {};
    const validationError = validateProductInput(product);
    if (validationError) return res.status(400).json({ error: validationError });

    const products = await readProducts();
    const nextProduct = {
      ...normalizeProductInput(product),
      id: product.id || Date.now().toString(),
      visible: product.visible !== undefined ? product.visible : true,
      inStock: product.inStock !== undefined ? product.inStock : Number(product.stockQuantity) > 0,
      stockQuantity: Number(product.stockQuantity) || 0,
    };

    if (isPostgresEnabled && pool) {
      await writeProduct(nextProduct);
    } else {
      products.push(nextProduct);
      await writeProducts(products);
    }
    res.json(nextProduct);
  } catch {
    console.error('Failed to create product.');
    res.status(500).json({ error: 'Unable to create product.' });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID.' });
    const validationError = validateProductInput(req.body || {}, true);
    if (validationError) return res.status(400).json({ error: validationError });
    const productUpdates = normalizeProductInput(req.body || {});
    const products = await readProducts();
    const index = products.findIndex((item) => String(item.id) === req.params.id);
    if (index < 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const updatedProduct = {
      ...products[index],
      ...productUpdates,
      id: req.params.id,
      stockQuantity: Number(productUpdates.stockQuantity ?? products[index].stockQuantity),
      inStock: productUpdates.inStock !== undefined ? productUpdates.inStock : Number(productUpdates.stockQuantity ?? products[index].stockQuantity) > 0,
    };

    if (isPostgresEnabled && pool) {
      await writeProduct(updatedProduct);
    } else {
      products[index] = updatedProduct;
      await writeProducts(products);
    }
    res.json(updatedProduct);
  } catch {
    console.error('Failed to update product.');
    res.status(500).json({ error: 'Unable to update product.' });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid product ID.' });
    const prodId = req.params.id;
    if (isPostgresEnabled && pool) {
      try {
        const result = await pool.query('DELETE FROM products WHERE id = $1', [prodId]);
        if (!result || typeof result.rowCount === 'undefined') {
          console.error('Unexpected delete result for product', prodId, result);
          return res.status(500).json({ error: 'Unexpected database response.' });
        }
        if (result.rowCount === 0) {
          return res.status(404).json({ error: 'Product not found.' });
        }
        return res.json({ success: true, deleted: result.rowCount });
      } catch {
        console.error('Failed to delete product from PostgreSQL.');
        return res.status(500).json({ error: 'Database error while deleting product.' });
      }
    }

    // Fallback to local JSON store when Postgres is not enabled
    const products = await readProducts();
    const updatedProducts = products.filter((item) => item.id !== prodId);
    await writeProducts(updatedProducts);
    res.json({ success: true });
  } catch {
    console.error('Failed to delete product.');
    res.status(500).json({ error: 'Unable to delete product.' });
  }
});

app.get('/api/orders', optionalAuthenticateToken, async (req, res) => {
  try {
    const orders = await readOrders();

    // 1. Admin gets all orders for management
    if (req.user?.isAdmin) {
      if (!await isCurrentAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
      return res.json(orders);
    }

    // 2. Authenticated Customer receives ONLY their own orders (isolated by JWT identity)
    if (req.user && req.user.id) {
      const userEmailLower = req.user.email ? String(req.user.email).toLowerCase() : '';
      const userId = req.user.id;

      const customerOrders = orders.filter((o) => {
        const cust = o.customer || {};
        const orderEmailLower = cust.email ? String(cust.email).toLowerCase() : '';

        if (cust.userId) return String(cust.userId) === String(userId);
        return userEmailLower && orderEmailLower && userEmailLower === orderEmailLower;
      });

      return res.json(customerOrders);
    }

    // 3. Unauthenticated requests return empty array
    return res.json([]);
  } catch {
    console.error('Failed to read orders.');
    res.status(500).json({ error: 'Unable to read orders.' });
  }
});

app.post('/api/orders', orderRateLimiter, optionalAuthenticateToken, async (req, res) => {
  try {
    const order = normalizeOrderPayload(req.body || {});
    const submittedCustomer = order.customer;
    if (!submittedCustomer || typeof submittedCustomer !== 'object' || Array.isArray(submittedCustomer) ||
        !Array.isArray(order.items) || order.items.length < 1 || order.items.length > 50) {
      return res.status(400).json({ error: 'Order must include customer and items.' });
    }
    if (!isValidName(submittedCustomer.name) || !isValidPhone(submittedCustomer.phone) ||
        typeof submittedCustomer.address !== 'string' || !submittedCustomer.address.trim() || submittedCustomer.address.length > 500 ||
        typeof submittedCustomer.city !== 'string' || !submittedCustomer.city.trim() || submittedCustomer.city.length > 100 ||
        !/^\d{6}$/.test(String(submittedCustomer.pincode || '')) ||
        typeof submittedCustomer.state !== 'string' || !submittedCustomer.state.trim() || submittedCustomer.state.length > 100 ||
        typeof submittedCustomer.district !== 'string' || !submittedCustomer.district.trim() || submittedCustomer.district.length > 100 ||
        (submittedCustomer.email && !isValidEmail(submittedCustomer.email))) {
      return res.status(400).json({ error: 'Enter valid customer and shipping details before placing the order.' });
    }

    const paymentMethod = String(order.paymentMethod || '').trim().toUpperCase();
    if (!['COD', 'UPI'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Select a valid payment method.' });
    }
    if (paymentMethod === 'UPI' && !/^[A-Za-z0-9-]{5,64}$/.test(String(submittedCustomer.transactionId || '').trim())) {
      return res.status(400).json({ error: 'Enter a valid UPI transaction reference.' });
    }

    const products = await readProducts();
    let itemsSubtotal = 0;
    const verifiedItems = [];
    for (const item of order.items) {
      const productId = String(item.product?.id || item.productId || '');
      const quantity = Number(item.quantity);
      if (!isValidResourceId(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        return res.status(400).json({ error: 'An order item has an invalid product or quantity.' });
      }

      const product = products.find((candidate) => String(candidate.id) === productId);
      if (!product || product.visible === false || product.inStock === false) {
        return res.status(400).json({ error: 'One or more selected products are unavailable.' });
      }

      const submittedLabel = String(item.weightOption?.label ?? item.weightOption?.weight ?? '');
      if (!submittedLabel || submittedLabel.length > 64) {
        return res.status(400).json({ error: 'Select a valid product option.' });
      }

      let selectedVariant;
      if (Array.isArray(product.weights) && product.weights.length > 0) {
        selectedVariant = product.weights.find((variant) => (
          String(variant.weight ?? variant.label ?? '').trim().toLowerCase() === submittedLabel.trim().toLowerCase()
        ));
      } else if (submittedLabel.trim().toLowerCase() === String(product.quantityType || 'Unit').trim().toLowerCase()) {
        selectedVariant = { weight: product.quantityType || 'Unit', price: product.pricePerUnit };
      }

      const unitPrice = Number(selectedVariant?.price);
      if (!selectedVariant || !Number.isFinite(unitPrice) || unitPrice <= 0) {
        return res.status(400).json({ error: 'A selected product option is no longer available.' });
      }

      itemsSubtotal += unitPrice * quantity;
      verifiedItems.push({
        product: {
          id: product.id,
          name: product.name,
          image: product.image || '',
          quantityType: product.quantityType || 'Unit',
        },
        quantity,
        weightOption: {
          label: String(selectedVariant.weight ?? selectedVariant.label ?? product.quantityType ?? 'Unit'),
          price: unitPrice,
        },
      });
    }

    // Server attaches verified authenticated customer identity if user is logged in
    if (req.user && !req.user.isAdmin) {
      order.customer.userId = req.user.id;
      order.customer.email = req.user.email;
    }
    if (req.user?.isAdmin || !req.user) delete order.customer.userId;

    // Re-calculate shipping charge server-side — ignore any client-submitted value
    const shippingRules = await readShippingRules();
    const customerState = order.customer?.state || '';
    const customerDistrict = order.customer?.district || '';
    const verifiedShippingCharge = calculateShippingCharge(customerState, customerDistrict, shippingRules);

    const verifiedTotal = itemsSubtotal + verifiedShippingCharge;

    const nextOrder = {
      id: `ORD${crypto.randomUUID()}`,
      date: new Date().toISOString(),
      status: 'Order Placed',
      paymentStatus: 'Pending',
      paymentMethod,
      trackingNumber: `TRK${Math.floor(100000 + Math.random() * 900000)}`,
      totalAmount: verifiedTotal,
      customer: {
        name: submittedCustomer.name.trim(),
        email: req.user && !req.user.isAdmin ? req.user.email : String(submittedCustomer.email || '').trim().toLowerCase(),
        phone: submittedCustomer.phone.trim(),
        address: submittedCustomer.address.trim(),
        city: submittedCustomer.city.trim(),
        shippingCharge: verifiedShippingCharge,
        itemsSubtotal,
        state: customerState,
        district: customerDistrict,
        pincode: String(submittedCustomer.pincode),
        transactionId: paymentMethod === 'UPI' ? String(submittedCustomer.transactionId).trim() : '',
        notes: typeof submittedCustomer.notes === 'string' ? submittedCustomer.notes.trim().slice(0, 1000) : '',
        ...(req.user && !req.user.isAdmin ? { userId: req.user.id } : {}),
      },
      items: verifiedItems,
    };

    if (isPostgresEnabled && pool) {
      await pool.query(
        `INSERT INTO orders (id, date, status, payment_status, payment_method, total_amount, tracking_number, customer, items)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          nextOrder.id,
          nextOrder.date,
          nextOrder.status,
          nextOrder.paymentStatus,
          nextOrder.paymentMethod,
          nextOrder.totalAmount,
          nextOrder.trackingNumber,
          JSON.stringify(nextOrder.customer),
          JSON.stringify(nextOrder.items),
        ]
      );
    } else {
      const existingOrders = await readOrders();
      existingOrders.unshift(nextOrder);
      await writeOrders(existingOrders);
    }
    res.json(nextOrder);
  } catch {
    console.error('Failed to create order.');
    res.status(500).json({ error: 'Unable to create order.' });
  }
});

app.put('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid order ID.' });
    const body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => !['status', 'paymentStatus'].includes(key))) {
      return res.status(400).json({ error: 'Invalid order update.' });
    }
    const updates = {};
    if (body.status !== undefined) {
      if (!['Order Placed', 'Packed', 'Dispatched', 'Delivered', 'Cancelled'].includes(body.status)) {
        return res.status(400).json({ error: 'A valid order status is required.' });
      }
      updates.status = body.status;
    }
    if (body.paymentStatus !== undefined) {
      if (!['Pending', 'Paid'].includes(body.paymentStatus)) {
        return res.status(400).json({ error: 'A valid payment status is required.' });
      }
      updates.paymentStatus = body.paymentStatus;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No order updates were provided.' });
    }

    if (isPostgresEnabled && pool) {
      const columns = { status: 'status', paymentStatus: 'payment_status' };
      const fields = Object.keys(updates);
      const assignments = fields.map((field, index) => `${columns[field]} = $${index + 1}`);
      const values = fields.map((field) => updates[field]);
      values.push(req.params.id);
      const { rows } = await pool.query(
        `UPDATE orders SET ${assignments.join(', ')} WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      const row = rows[0];
      return res.json({
        id: row.id,
        date: row.date,
        status: row.status,
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method,
        totalAmount: Number(row.total_amount),
        trackingNumber: row.tracking_number,
        customer: row.customer || {},
        items: row.items || [],
      });
    }

    const orders = await readOrders();
    const index = orders.findIndex((item) => String(item.id) === req.params.id);
    if (index < 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    orders[index] = {
      ...orders[index],
      ...updates,
    };
    await writeOrders(orders);
    res.json(orders[index]);
  } catch {
    console.error('Failed to update order.');
    res.status(500).json({ error: 'Unable to update order.' });
  }
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid order ID.' });
    if (isPostgresEnabled && pool) {
      const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
      if (rowCount === 0) {
        return res.status(404).json({ error: 'Order not found.' });
      }
      return res.json({ success: true });
    }

    const orders = await readOrders();
    const updatedOrders = orders.filter((item) => String(item.id) !== req.params.id);
    if (updatedOrders.length === orders.length) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    await writeOrders(updatedOrders);
    res.json({ success: true });
  } catch {
    console.error('Failed to delete order.');
    res.status(500).json({ error: 'Unable to delete order.' });
  }
});

// --- AUTH HELPERS ---
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authenticateToken(req, res, next) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authorization.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.id || !decoded.email || typeof decoded.email !== 'string') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuthenticateToken(req, res, next) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    req.user = null;
    return next();
  }
  return authenticateToken(req, res, next);
}

// Register user
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if (!isValidName(name) || !isValidEmail(email) || !isValidPassword(password)) {
      return res.status(400).json({ error: 'Enter a valid name, email address, and password of 8 to 72 bytes.' });
    }
    if (phone && !isValidPhone(phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    const cleanPhone = phone ? phone.trim() : '';
    // check existing
    if (isPostgresEnabled && pool) {
      const existing = await runQueryLogged('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
      if (existing.rowCount > 0) return res.status(409).json({ error: 'Email already registered' });

      const id = crypto.randomUUID();
      const hash = await bcrypt.hash(password, 12);
      await runQueryLogged(
        'INSERT INTO users (id, name, email, phone, password_hash, is_admin) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, cleanName, cleanEmail, cleanPhone, hash, false]
      );
      const token = generateToken({ id, email: cleanEmail, name: cleanName, isAdmin: false });
      return res.json({ id, name: cleanName, email: cleanEmail, token });
    }

    // JSON fallback
    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    if (profiles[cleanEmail]) return res.status(409).json({ error: 'Email already registered' });
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 12);
    profiles[cleanEmail] = { id, name: cleanName, email: cleanEmail, phone: cleanPhone, password_hash: hash, created_at: new Date().toISOString() };
    await writeJsonFile(userProfilesFile, profiles);
    const token = generateToken({ id, email: cleanEmail, name: cleanName, isAdmin: false });
    return res.json({ id, name: cleanName, email: cleanEmail, token });
  } catch {
    console.error('Customer registration failed.');
    res.status(500).json({ error: 'Unable to register' });
  }
});

// Login user
app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !isValidPassword(password, 1)) {
      return res.status(400).json({ error: 'A valid email and password are required.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    if (isPostgresEnabled && pool) {
      const { rows } = await pool.query('SELECT id, name, email, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const storedPassword = String(user.password_hash || '');
      const ok = await passwordsMatch(storedPassword, password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      if (!/^\$2[aby]\$/.test(storedPassword)) {
        const migratedHash = await bcrypt.hash(password, 12);
        await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [migratedHash, user.id]);
      }
      const token = generateToken({ id: user.id, email: user.email, name: user.name, isAdmin: false });
      return res.json({ id: user.id, name: user.name, email: user.email, isAdmin: false, token });
    } else {
      await ensureStore();
      const profiles = await readJsonFile(userProfilesFile, {});

      const profile = profiles[cleanEmail];
      if (!profile) return res.status(401).json({ error: 'Invalid credentials' });
      const storedPassword = String(profile.password_hash || '');
      const ok = await passwordsMatch(storedPassword, password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      if (!/^\$2[aby]\$/.test(storedPassword)) {
        profile.password_hash = await bcrypt.hash(password, 12);
        profile.updated_at = new Date().toISOString();
        await writeJsonFile(userProfilesFile, profiles);
      }
      const token = generateToken({ id: profile.id, email: profile.email, name: profile.name, isAdmin: false });
      return res.json({ id: profile.id, name: profile.name, email: profile.email, token });
    }
  } catch {
    console.error('Customer login failed.');
    res.status(500).json({ error: 'Unable to login' });
  }
});

// Get / update profile
app.get('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    if (req.user?.isAdmin) {
      if (!await isCurrentAdmin(req.user)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.json({ id: req.user.id, name: req.user.name || 'Administrator', email: req.user.email, phone: '', isAdmin: true });
    }

    const userId = req.user.id;
    if (isPostgresEnabled && pool) {
      const { rows } = await pool.query(
        'SELECT id, name, email, phone FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      const u = rows[0];
      if (!u) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: u.id, name: u.name, email: u.email || '', phone: u.phone || '', isAdmin: false });
    }
    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    const p = Object.values(profiles).find((profile) => profile.id === userId);
    if (!p) return res.status(404).json({ error: 'Not found' });
    return res.json({ id: p.id, name: p.name, email: p.email || '', phone: p.phone || '', isAdmin: false });
  } catch {
    console.error('Failed to read the authenticated profile.');
    res.status(500).json({ error: 'Unable to fetch profile' });
  }
});

app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const updates = req.body || {};
    if (req.user?.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) ||
        Object.keys(updates).some((key) => !['name', 'phone'].includes(key))) {
      return res.status(400).json({ error: 'Invalid profile update.' });
    }
    if (updates.name !== undefined && !isValidName(updates.name)) {
      return res.status(400).json({ error: 'Enter a valid name.' });
    }
    if (updates.phone !== undefined && updates.phone !== '' && !isValidPhone(updates.phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number.' });
    }
    if (updates.email !== undefined) {
      return res.status(400).json({ error: 'Email cannot be changed through this endpoint.' });
    }
    const userId = req.user.id;
    if (isPostgresEnabled && pool) {
      const { rows } = await pool.query(
        'SELECT id FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      const u = rows[0];
      if (!u) return res.status(404).json({ error: 'Not found' });
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), updated_at = $3 WHERE id = $4',
        [updates.name || null, updates.phone || null, now, u.id]
      );
      return res.json({ success: true });
    }
    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    const key = Object.keys(profiles).find((profileKey) => profiles[profileKey].id === userId);
    if (!key || !profiles[key]) return res.status(404).json({ error: 'Not found' });
    profiles[key].name = updates.name || profiles[key].name;
    profiles[key].phone = updates.phone || profiles[key].phone;
    profiles[key].updated_at = new Date().toISOString();
    await writeJsonFile(userProfilesFile, profiles);
    return res.json({ success: true });
  } catch {
    console.error('Failed to update the authenticated profile.');
    res.status(500).json({ error: 'Unable to update profile' });
  }
});

// ----------------------------------------------------
// EMAIL OTP FORGOT PASSWORD & PASSWORD RESET ENDPOINTS
// ----------------------------------------------------

// 1. Request Password Reset OTP
app.post(['/api/auth/forgot-password', '/api/auth/forgot'], otpRequestRateLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const cleanEmail = email.trim().toLowerCase();

    const genericResponse = {
      success: true,
      message: 'OTP sent to your registered email.'
    };

    let userExists = false;
    let userId = null;

    if (isPostgresEnabled && pool) {
      const userRes = await runQueryLogged('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
      if (userRes.rows.length > 0) {
        userExists = true;
        userId = userRes.rows[0].id;
      }
    } else {
      await ensureStore();
      const profiles = await readJsonFile(userProfilesFile, {});
      if (profiles[cleanEmail]) {
        userExists = true;
        userId = profiles[cleanEmail].id;
      }
    }

    if (!userExists) {
      return res.json(genericResponse);
    }

    // Rate-limiting check: 60 seconds minimum between requests for same email
    if (isPostgresEnabled && pool) {
      const recent = await runQueryLogged(
        "SELECT created_at FROM password_reset_otps WHERE LOWER(email) = $1 AND created_at > NOW() - INTERVAL '60 seconds' LIMIT 1",
        [cleanEmail]
      );
      if (recent.rows.length > 0) {
        return res.json(genericResponse);
      }
    }

    // Generate cryptographically secure 6-digit OTP
    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const otpHash = await bcrypt.hash(otpCode, 10);
    const otpId = `otp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    if (isPostgresEnabled && pool) {
      // Invalidate existing OTPs for this email
      await runQueryLogged('DELETE FROM password_reset_otps WHERE LOWER(email) = $1', [cleanEmail]);
      await runQueryLogged(
        'INSERT INTO password_reset_otps (id, user_id, email, otp_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [otpId, userId, cleanEmail, otpHash, expiresAt]
      );
    } else {
      await ensureStore();
      const profiles = await readJsonFile(userProfilesFile, {});
      if (profiles[cleanEmail]) {
        const lastRequestedAt = profiles[cleanEmail].pending_otp_created;
        if (lastRequestedAt && Date.now() - new Date(lastRequestedAt).getTime() < 60 * 1000) {
          return res.json(genericResponse);
        }
        profiles[cleanEmail].pending_otp_hash = otpHash;
        profiles[cleanEmail].pending_otp_expires = expiresAt.toISOString();
        profiles[cleanEmail].pending_otp_created = new Date().toISOString();
        profiles[cleanEmail].pending_otp_attempts = 0;
        await writeJsonFile(userProfilesFile, profiles);
      }
    }

    // Dispatch OTP via Brevo email service
    const emailResult = await sendPasswordResetOTP(cleanEmail, otpCode);
    console.info('Password reset OTP dispatch result', {
      result: emailResult.reason,
      status: emailResult.status || null,
    });

    return res.json(genericResponse);
  } catch {
    console.error('Customer password reset request failed.');
    return res.status(500).json({ error: 'Unable to process password reset request.' });
  }
});

// 2. Verify Password Reset OTP
app.post('/api/auth/verify-reset-otp', otpVerifyRateLimiter, async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!isValidEmail(email) || typeof otp !== 'string') {
      return res.status(400).json({ error: 'Email and 6-digit verification code are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.trim();

    if (cleanOtp.length !== 6 || !/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({ error: 'Verification code must be 6 digits' });
    }

    if (isPostgresEnabled && pool) {
      const { rows } = await runQueryLogged(
        `UPDATE password_reset_otps
         SET attempts = attempts + 1
         WHERE id = (
           SELECT id FROM password_reset_otps
           WHERE LOWER(email) = $1 AND verified = FALSE AND expires_at > NOW()
             AND attempts < max_attempts
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE
         )
         RETURNING id, user_id, otp_hash, attempts, max_attempts`,
        [cleanEmail]
      );

      const record = rows[0];
      if (!record) {
        return res.status(400).json({ error: 'Invalid or expired verification code. Please request a new code.' });
      }

      const matches = await bcrypt.compare(cleanOtp, record.otp_hash);
      if (!matches) {
        const remaining = Math.max(record.max_attempts - record.attempts, 0);
        return res.status(400).json({
          error: remaining > 0 ? `Incorrect verification code. ${remaining} attempts remaining.` : 'Maximum verification attempts exceeded. Please request a new code.'
        });
      }

      // Generate single-use reset token
      const rawResetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = await bcrypt.hash(rawResetToken, 10);

      const consumedOtp = await runQueryLogged(
        'UPDATE password_reset_otps SET verified = TRUE, reset_token_hash = $1 WHERE id = $2 AND verified = FALSE RETURNING id',
        [resetTokenHash, record.id]
      );
      if (consumedOtp.rowCount !== 1) {
        return res.status(400).json({ error: 'Invalid or expired verification code. Please request a new code.' });
      }

      return res.json({
        success: true,
        resetToken: `${record.id}:${rawResetToken}`
      });
    } else {
      await ensureStore();
      const profiles = await readJsonFile(userProfilesFile, {});
      const p = profiles[cleanEmail];
      if (!p || !p.pending_otp_hash || new Date(p.pending_otp_expires) < new Date()) {
        return res.status(400).json({ error: 'Invalid or expired verification code.' });
      }

      const attempts = Number(p.pending_otp_attempts) || 0;
      if (attempts >= 5) {
        return res.status(429).json({ error: 'Maximum verification attempts exceeded. Please request a new code.' });
      }
      p.pending_otp_attempts = attempts + 1;

      const matches = await bcrypt.compare(cleanOtp, p.pending_otp_hash);
      if (!matches) {
        await writeJsonFile(userProfilesFile, profiles);
        return res.status(400).json({ error: 'Incorrect verification code.' });
      }

      const rawResetToken = crypto.randomBytes(32).toString('hex');
      p.reset_token_hash = await bcrypt.hash(rawResetToken, 10);
      p.reset_token_expires = p.pending_otp_expires;
      delete p.pending_otp_hash;
      delete p.pending_otp_expires;
      delete p.pending_otp_attempts;
      delete p.pending_otp_created;
      await writeJsonFile(userProfilesFile, profiles);

      return res.json({
        success: true,
        resetToken: `${p.id}:${rawResetToken}`
      });
    }
  } catch {
    console.error('Customer verification-code check failed.');
    return res.status(500).json({ error: 'Unable to verify verification code.' });
  }
});

// 3. Reset Password with Reset Token
app.post('/api/auth/reset-password', passwordResetRateLimiter, async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body || {};
    if (!isValidEmail(email) || typeof resetToken !== 'string' || !isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'A valid email, reset token, and password of at least 8 characters are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const parts = resetToken.split(':');
    if (parts.length !== 2 || !isValidResourceId(parts[0]) || !/^[a-f0-9]{64}$/i.test(parts[1])) {
      return res.status(400).json({ error: 'Invalid reset session. Please request a new code.' });
    }

    const [recordId, rawToken] = parts;

    if (isPostgresEnabled && pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          'SELECT id, user_id, reset_token_hash FROM password_reset_otps WHERE id = $1 AND LOWER(email) = $2 AND verified = TRUE AND expires_at > NOW() FOR UPDATE',
          [recordId, cleanEmail]
        );
        const record = rows[0];
        if (!record?.reset_token_hash || !(await bcrypt.compare(rawToken, record.reset_token_hash))) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Reset session expired or invalid. Please request a new verification code.' });
        }
        const newHash = await bcrypt.hash(newPassword, 12);
        const updated = await client.query(
          'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
          [newHash, record.user_id]
        );
        if (updated.rowCount !== 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Reset session expired or invalid. Please request a new verification code.' });
        }
        await client.query('DELETE FROM password_reset_otps WHERE id = $1', [record.id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return res.json({ success: true, message: 'Password updated successfully. Please log in with your new password.' });
    } else {
      await ensureStore();
      const profiles = await readJsonFile(userProfilesFile, {});
      const p = profiles[cleanEmail];
      if (!p || !p.reset_token_hash || !p.reset_token_expires || new Date(p.reset_token_expires) <= new Date()) {
        return res.status(400).json({ error: 'Reset session expired or invalid.' });
      }

      const validToken = await bcrypt.compare(rawToken, p.reset_token_hash);
      if (!validToken) {
        return res.status(400).json({ error: 'Invalid reset session.' });
      }

      p.password_hash = await bcrypt.hash(newPassword, 10);
      delete p.reset_token_hash;
      delete p.reset_token_expires;
      p.updated_at = new Date().toISOString();
      await writeJsonFile(userProfilesFile, profiles);

      return res.json({ success: true, message: 'Password updated successfully. Please log in.' });
    }
  } catch {
    console.error('Customer password reset failed.');
    return res.status(500).json({ error: 'Unable to reset password.' });
  }
});

app.post('/api/auth/reset', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (req.user?.isAdmin || !isValidPassword(currentPassword, 1) || !isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'Current password and a new password of at least 8 characters are required.' });
    }

    const email = req.user.email;
    if (isPostgresEnabled && pool) {
      
      const { rows } = await pool.query('SELECT password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
      const user = rows[0];
      if (!user) return res.status(404).json({ error: 'User not found.' });
      const ok = await passwordsMatch(user.password_hash, currentPassword);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2', [passwordHash, email]);
      return res.json({ success: true });
    }

    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    const profile = profiles[email];
    if (!profile) return res.status(404).json({ error: 'User not found.' });
    const ok = await passwordsMatch(profile.password_hash, currentPassword);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    profile.password_hash = passwordHash;
    profile.updated_at = new Date().toISOString();
    await writeJsonFile(userProfilesFile, profiles);
    return res.json({ success: true });
  } catch {
    console.error('Failed to reset the authenticated password.');
    res.status(500).json({ error: 'Unable to reset password.' });
  }
});

app.get('/api/reviews', optionalAuthenticateToken, async (req, res) => {
  try {
    const reviews = await readReviews();
    if (req.user?.isAdmin && !await isCurrentAdmin(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json((req.user?.isAdmin ? reviews : reviews.filter((review) => review.visible !== false)).map(toPublicReview));
  } catch {
    console.error('Failed to read reviews.');
    res.status(500).json({ error: 'Unable to read reviews.' });
  }
});

// Create a review (requires auth)
app.post('/api/reviews', authenticateToken, async (req, res) => {
  try {
    const review = req.body || {};
    const product = String(review.product || '').trim();
    const text = String(review.text || '').trim();
    const rating = Number(review.rating);
    const isAdmin = req.user?.isAdmin && await isCurrentAdmin(req.user);
    if (req.user?.isAdmin && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    if (!product || product.length > 100) return res.status(400).json({ error: 'Select a valid product before submitting your review.' });
    if (!isAdmin && product.toLowerCase() !== 'j&d foods' &&
        !(await readProducts()).some((item) => String(item.name || '').trim().toLowerCase() === product.toLowerCase())) {
      return res.status(400).json({ error: 'Select a valid product before submitting your review.' });
    }
    if (isAdmin && !isValidName(review.name, 100)) return res.status(400).json({ error: 'Enter a valid reviewer name.' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
    }
    if (!text || text.length > 2000 || containsControlCharacters(text)) {
      return res.status(400).json({ error: 'Write a valid review of no more than 2,000 characters.' });
    }

    const reviews = await readReviews();
    const userId = req.user.id;
    const userEmail = req.user.email;
    const userName = isAdmin ? review.name.trim() : (req.user.name || req.user.email);

    const normalizedProduct = product.toLocaleLowerCase();
    const normalizedEmail = String(userEmail || '').toLocaleLowerCase();
    const exists = isAdmin ? null : reviews.find((existingReview) => (
      String(existingReview.product || '').trim().toLocaleLowerCase() === normalizedProduct &&
      (
        (userId && String(existingReview.user_id || '') === String(userId)) ||
        (normalizedEmail && String(existingReview.user_email || '').toLocaleLowerCase() === normalizedEmail)
      )
    ));
    if (exists) {
      return res.status(409).json({ error: 'User has already reviewed this product' });
    }

    const now = new Date().toISOString();
    const customerOrders = isAdmin ? [] : await readOrders();
    const verifiedBuyer = !isAdmin && customerOrders.some((order) => {
      const customer = order.customer || {};
      return (customer.userId && String(customer.userId) === String(userId)) ||
        (customer.email && String(customer.email).trim().toLowerCase() === normalizedEmail);
    });
    const nextReview = {
      id: crypto.randomUUID(),
      name: userName,
      product,
      rating,
      date: now,
      visible: true,
      verifiedBuyer,
      text,
      ...(isAdmin ? {} : { user_id: userId, user_email: userEmail, user_name: userName }),
      created_at: now,
      updated_at: now,
    };

    if (isPostgresEnabled && pool) {
      await pool.query(
        `INSERT INTO reviews (id, name, product, rating, date, text, visible, verified_buyer, user_id, user_email, user_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          nextReview.id,
          nextReview.name,
          nextReview.product,
          nextReview.rating,
          nextReview.date,
          nextReview.text,
          nextReview.visible,
          nextReview.verifiedBuyer,
          nextReview.user_id || null,
          nextReview.user_email || null,
          nextReview.user_name || null,
          nextReview.created_at,
          nextReview.updated_at,
        ]
      );
    } else {
      reviews.unshift(nextReview);
      await writeReviews(reviews);
    }

    res.json(toPublicReview(nextReview));
  } catch {
    console.error('Failed to create review.');
    res.status(500).json({ error: 'Unable to create review.' });
  }
});

// Delete review (admin only)
app.delete('/api/reviews/:id', requireAdmin, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid review ID.' });
    const reviews = await readReviews();
    const index = reviews.findIndex((item) => String(item.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ error: 'Review not found' });
    const updated = reviews.filter((item) => String(item.id) !== String(req.params.id));
    await writeReviews(updated);
    res.json({ success: true });
  } catch {
    console.error('Failed to delete review.');
    res.status(500).json({ error: 'Unable to delete review.' });
  }
});

// Update review (auth + ownership or admin)
app.put('/api/reviews/:id', authenticateToken, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid review ID.' });
    const updates = req.body || {};
    const allowedFields = req.user?.isAdmin ? ['name', 'text', 'rating', 'visible'] : ['text', 'rating'];
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) ||
        Object.keys(updates).some((key) => !allowedFields.includes(key))) {
      return res.status(400).json({ error: 'Invalid review update.' });
    }
    if (updates.text !== undefined &&
        (typeof updates.text !== 'string' || !updates.text.trim() || updates.text.length > 2000 ||
         containsControlCharacters(updates.text))) {
      return res.status(400).json({ error: 'Write a valid review of no more than 2,000 characters.' });
    }
    if (updates.name !== undefined && (!req.user?.isAdmin || !isValidName(updates.name, 100))) {
      return res.status(400).json({ error: 'Enter a valid reviewer name.' });
    }
    if (updates.rating !== undefined && (!Number.isInteger(Number(updates.rating)) || Number(updates.rating) < 1 || Number(updates.rating) > 5)) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
    }
    if (updates.visible !== undefined && (typeof updates.visible !== 'boolean' || !req.user?.isAdmin)) {
      return res.status(400).json({ error: 'Invalid review visibility.' });
    }
    const reviews = await readReviews();
    const index = reviews.findIndex((item) => String(item.id) === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Review not found' });
    const target = reviews[index];
    const isOwner = req.user.isAdmin
      ? await isCurrentAdmin(req.user)
      : (target.user_id && String(target.user_id) === String(req.user.id)) ||
        (target.user_email && String(target.user_email).trim().toLowerCase() === String(req.user.email).trim().toLowerCase());
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
    const safeUpdates = { ...updates };
    if (safeUpdates.text !== undefined) safeUpdates.text = safeUpdates.text.trim();
    if (safeUpdates.rating !== undefined) safeUpdates.rating = Number(safeUpdates.rating);
    if (safeUpdates.name !== undefined) safeUpdates.name = safeUpdates.name.trim();
    const now = new Date().toISOString();
    reviews[index] = {
      ...reviews[index],
      ...safeUpdates,
      updated_at: now,
      id: reviews[index].id,
    };
    await writeReviews(reviews);
    res.json(toPublicReview(reviews[index]));
  } catch {
    console.error('Failed to update review.');
    res.status(500).json({ error: 'Unable to update review.' });
  }
});

app.get('/api/offers', optionalAuthenticateToken, async (req, res) => {
  try {
    const offers = await readOffers();
    if (req.user?.isAdmin && !await isCurrentAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
    res.json(req.user?.isAdmin ? offers : offers.filter((offer) => offer.active !== false));
  } catch {
    console.error('Failed to read offers.');
    res.status(500).json({ error: 'Unable to read offers.' });
  }
});

app.post('/api/offers', requireAdmin, async (req, res) => {
  try {
    const offer = req.body || {};
    if (!offer || typeof offer !== 'object' || Array.isArray(offer) ||
        Object.keys(offer).some((key) => !['id', 'code', 'title', 'description', 'discount', 'active', 'productId', 'minOrderValue'].includes(key)) ||
        (offer.id !== undefined && offer.id !== '' && !isValidResourceId(String(offer.id))) ||
        typeof offer.code !== 'string' || !/^[A-Za-z0-9_-]{2,32}$/.test(offer.code.trim()) ||
        typeof offer.title !== 'string' || !offer.title.trim() || offer.title.length > 150 ||
        (offer.description !== undefined && (typeof offer.description !== 'string' || offer.description.length > 1000)) ||
        !Number.isFinite(Number(offer.discount)) || Number(offer.discount) < 0 || Number(offer.discount) > 100 ||
        (offer.active !== undefined && typeof offer.active !== 'boolean') ||
        (offer.productId !== undefined && offer.productId !== '' && !isValidResourceId(String(offer.productId))) ||
        !isNonNegativeAmount(offer.minOrderValue ?? 0)) {
      return res.status(400).json({ error: 'Enter valid offer details.' });
    }
    const offers = await readOffers();
    const nextOffer = {
      ...offer,
      id: offer.id || `o${Date.now().toString().slice(-8)}`,
      code: (offer.code || '').toUpperCase().trim(),
      title: offer.title || '',
      description: offer.description || '',
      discount: Number(offer.discount) || 0,
      active: offer.active !== undefined ? offer.active : true,
      productId: offer.productId || '',
      minOrderValue: Number(offer.minOrderValue) || 0,
    };
    const existingIndex = offers.findIndex((item) => item.id === nextOffer.id);
    if (existingIndex >= 0) {
      offers[existingIndex] = nextOffer;
    } else {
      offers.push(nextOffer);
    }
    await writeOffers(offers);
    res.json(nextOffer);
  } catch {
    console.error('Failed to save offer.');
    res.status(500).json({ error: 'Unable to save offer.' });
  }
});

app.delete('/api/offers/:id', requireAdmin, async (req, res) => {
  try {
    if (!isValidResourceId(req.params.id)) return res.status(400).json({ error: 'Invalid offer ID.' });
    const offers = await readOffers();
    const updatedOffers = offers.filter((item) => item.id !== req.params.id);
    await writeOffers(updatedOffers);
    res.json({ success: true });
  } catch {
    console.error('Failed to delete offer.');
    res.status(500).json({ error: 'Unable to delete offer.' });
  }
});

app.get('/api/store-settings', async (_req, res) => {
  try {
    const settings = await readStoreSettings();
    res.json(settings);
  } catch {
    console.error('Failed to read store settings.');
    res.status(500).json({ error: 'Unable to read store settings.' });
  }
});

app.post('/api/store-settings', requireAdmin, async (req, res) => {
  try {
    const settings = req.body || {};
    if (!isValidSettingsObject(settings) ||
        (settings.businessName !== undefined && !isValidName(settings.businessName, 150)) ||
        (settings.contactNumber !== undefined && !isValidPhone(settings.contactNumber)) ||
        (settings.whatsappNumber !== undefined && !isValidPhone(settings.whatsappNumber)) ||
        (settings.email !== undefined && !isValidEmail(settings.email)) ||
        (settings.logoUrl !== undefined && !isSafeImageUrl(settings.logoUrl)) ||
        (settings.heroBackgroundUrl !== undefined && !isSafeImageUrl(settings.heroBackgroundUrl)) ||
        (settings.featureImageUrl !== undefined && !isSafeImageUrl(settings.featureImageUrl)) ||
        (settings.heroDesktopImageUrl !== undefined && !isSafeImageUrl(settings.heroDesktopImageUrl)) ||
        (settings.heroMobileImageUrl !== undefined && !isSafeImageUrl(settings.heroMobileImageUrl)) ||
        (settings.heroTitle !== undefined && (typeof settings.heroTitle !== 'string' || settings.heroTitle.length > 100)) ||
        (settings.heroSubtitle !== undefined && (typeof settings.heroSubtitle !== 'string' || settings.heroSubtitle.length > 300)) ||
        (settings.logoZoom !== undefined && (typeof settings.logoZoom !== 'number' || !Number.isFinite(settings.logoZoom) || settings.logoZoom < 1 || settings.logoZoom > 3)) ||
        (settings.logoPositionX !== undefined && (typeof settings.logoPositionX !== 'number' || !Number.isFinite(settings.logoPositionX) || settings.logoPositionX < 0 || settings.logoPositionX > 100)) ||
        (settings.logoPositionY !== undefined && (typeof settings.logoPositionY !== 'number' || !Number.isFinite(settings.logoPositionY) || settings.logoPositionY < 0 || settings.logoPositionY > 100)) ||
        (settings.heroGradientOverlay !== undefined && typeof settings.heroGradientOverlay !== 'boolean') ||
        (settings.address !== undefined && (typeof settings.address !== 'string' || settings.address.length > 500))) {
      return res.status(400).json({ error: 'Enter valid store settings.' });
    }
    const saved = await writeStoreSettings(settings);
    res.json(saved);
  } catch {
    console.error('Failed to save store settings.');
    res.status(500).json({ error: 'Unable to save store settings.' });
  }
});

app.get('/api/payment-settings', async (_req, res) => {
  try {
    const settings = await readPaymentSettings();
    res.json(settings);
  } catch {
    console.error('Failed to read payment settings.');
    res.status(500).json({ error: 'Unable to read payment settings.' });
  }
});

app.post('/api/payment-settings', requireAdmin, async (req, res) => {
  try {
    const settings = req.body || {};
    if (!isValidSettingsObject(settings) ||
        (settings.qrImage !== undefined && !isSafeImageUrl(settings.qrImage)) ||
        (settings.upiId !== undefined && (typeof settings.upiId !== 'string' || !/^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,100}$/.test(settings.upiId))) ||
        (settings.phone !== undefined && !isValidPhone(settings.phone)) ||
        ['enableCOD', 'enableUPI', 'enableScanner'].some((key) => settings[key] !== undefined && typeof settings[key] !== 'boolean') ||
        ['scannerNote', 'instructions'].some((key) => settings[key] !== undefined && (typeof settings[key] !== 'string' || settings[key].length > 2000))) {
      return res.status(400).json({ error: 'Enter valid payment settings.' });
    }
    const saved = await writePaymentSettings(settings);
    res.json(saved);
  } catch {
    console.error('Failed to save payment settings.');
    res.status(500).json({ error: 'Unable to save payment settings.' });
  }
});

app.get('/api/admin-profile', requireAdmin, async (_req, res) => {
  try {
    const profile = await readAdminProfile();
    res.json(profile);
  } catch {
    console.error('Failed to read admin profile.');
    res.status(500).json({ error: 'Unable to read admin profile.' });
  }
});

app.post('/api/admin-profile', requireAdmin, async (req, res) => {
  try {
    const profile = req.body || {};
    if (!isValidSettingsObject(profile) ||
        (profile.ownerName !== undefined && !isValidName(profile.ownerName, 150)) ||
        (profile.businessName !== undefined && !isValidName(profile.businessName, 150)) ||
        (profile.email !== undefined && !isValidEmail(profile.email)) ||
        (profile.phone !== undefined && !isValidPhone(profile.phone)) ||
        (profile.whatsapp !== undefined && !isValidPhone(profile.whatsapp)) ||
        ['instagram', 'mapLink', 'profileImage', 'logoImage'].some((key) => (
          profile[key] !== undefined && (
            typeof profile[key] !== 'string' || profile[key].length > 2000 ||
            (profile[key] !== '' && !/^https:\/\/[^\s]+$/i.test(profile[key]))
          )
        )) ||
        (profile.address !== undefined && (typeof profile.address !== 'string' || profile.address.length > 500))) {
      return res.status(400).json({ error: 'Enter valid admin profile details.' });
    }
    const saved = await writeAdminProfile(profile);
    res.json(saved);
  } catch {
    console.error('Failed to save admin profile.');
    res.status(500).json({ error: 'Unable to save admin profile.' });
  }
});

app.get('/api/product-types', async (_req, res) => {
  try {
    const types = await readProductTypes();
    res.json(types);
  } catch {
    console.error('Failed to read product types.');
    res.status(500).json({ error: 'Unable to read product types.' });
  }
});

app.post('/api/product-types', requireAdmin, async (req, res) => {
  try {
    const types = req.body || [];
    if (!Array.isArray(types) || types.length > 100 ||
        types.some((type) => typeof type !== 'string' || !type.trim() || type.trim().length > 100) ||
        new Set(types.map((type) => String(type).trim().toLowerCase())).size !== types.length) {
      return res.status(400).json({ error: 'Enter a valid list of product types.' });
    }
    const saved = await writeProductTypes(types);
    res.json(saved);
  } catch {
    console.error('Failed to save product types.');
    res.status(500).json({ error: 'Unable to save product types.' });
  }
});

app.get('/api/user-profiles/:email', authenticateOwnerOrAdmin, async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (!req.user.isAdmin && String(req.user.email).trim().toLowerCase() !== email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const profile = await readUserProfile(email);
    res.json(profile);
  } catch {
    console.error('Failed to read user profile.');
    res.status(500).json({ error: 'Unable to read user profile.' });
  }
});

app.post('/api/user-profiles/:email', authenticateOwnerOrAdmin, async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (!req.user.isAdmin && String(req.user.email).trim().toLowerCase() !== email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const profile = req.body;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
        Object.keys(profile).some((key) => !['name', 'email', 'phone', 'addresses', 'wishlist'].includes(key))) {
      return res.status(400).json({ error: 'Invalid profile data.' });
    }
    if (profile.name !== undefined && profile.name !== '' && !isValidName(profile.name)) {
      return res.status(400).json({ error: 'Enter a valid profile name.' });
    }
    if (profile.phone !== undefined && profile.phone !== '' && !isValidPhone(profile.phone)) {
      return res.status(400).json({ error: 'Enter a valid phone number.' });
    }
    if (profile.addresses !== undefined) {
      if (!Array.isArray(profile.addresses) || profile.addresses.length > 20 ||
          profile.addresses.some((address) => (
            !address || typeof address !== 'object' || Array.isArray(address) ||
            Object.keys(address).some((key) => !['id', 'label', 'name', 'phone', 'street', 'city', 'state', 'pincode', 'landmark'].includes(key)) ||
            !isValidResourceId(String(address.id || '')) ||
            (address.phone && !isValidPhone(address.phone)) ||
            (address.pincode && !/^\d{6}$/.test(String(address.pincode))) ||
            ['label', 'name', 'street', 'city', 'state', 'landmark'].some((key) => (
              address[key] !== undefined && (typeof address[key] !== 'string' || address[key].length > 500)
            ))
          ))) {
        return res.status(400).json({ error: 'One or more saved addresses are invalid.' });
      }
    }
    if (profile.wishlist !== undefined &&
        (!Array.isArray(profile.wishlist) || profile.wishlist.length > 500 ||
         profile.wishlist.some((id) => !isValidResourceId(String(id))))) {
      return res.status(400).json({ error: 'Wishlist contains an invalid product ID.' });
    }
    if (profile.email !== undefined && String(profile.email).trim().toLowerCase() !== email) {
      return res.status(400).json({ error: 'Profile email cannot be changed.' });
    }
    const currentProfile = await readUserProfile(email);
    const saved = await writeUserProfile(email, { ...currentProfile, ...profile, email });
    res.json(saved);
  } catch {
    console.error('Failed to save user profile.');
    res.status(500).json({ error: 'Unable to save user profile.' });
  }
});

// Lightweight health endpoint for Render health checks
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Fallback root health endpoint (Render may probe '/')
app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/customers', requireAdmin, async (_req, res) => {
  try {
    const customers = await readCustomers();
    res.json(customers);
  } catch {
    console.error('Failed to read customers.');
    res.status(500).json({ error: 'Unable to read customers.' });
  }
});

// --- SHIPPING RULES ---

app.get('/api/shipping-rules', async (_req, res) => {
  try {
    const rules = await readShippingRules();
    res.json(rules);
  } catch {
    console.error('Failed to read shipping rules.');
    res.status(500).json({ error: 'Unable to read shipping rules.' });
  }
});

app.post('/api/shipping-rules', requireAdmin, async (req, res) => {
  try {
    const rules = req.body || {};
    const validCharge = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100_000;
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) ||
        !validCharge(rules.defaultCharge) || !rules.states || typeof rules.states !== 'object' || Array.isArray(rules.states) ||
        Object.keys(rules.states).length > 100 ||
        Object.entries(rules.states).some(([stateName, state]) => (
          !stateName.trim() || stateName.length > 100 ||
          !state || typeof state !== 'object' || Array.isArray(state) ||
          (state.defaultCharge !== undefined && !validCharge(state.defaultCharge)) ||
          !state.districts || typeof state.districts !== 'object' || Array.isArray(state.districts) ||
          Object.keys(state.districts).length > 200 ||
          Object.entries(state.districts).some(([districtName, district]) => (
            !districtName.trim() || districtName.length > 100 ||
            (typeof district === 'object' && district !== null
              ? (!validCharge(district.charge) || (district.active !== undefined && typeof district.active !== 'boolean'))
              : !validCharge(district))
          ))
        ))) {
      return res.status(400).json({ error: 'Enter valid shipping rules.' });
    }
    const saved = await writeShippingRules(rules);
    res.json(saved);
  } catch {
    console.error('Failed to save shipping rules.');
    res.status(500).json({ error: 'Unable to save shipping rules.' });
  }
});

// PIN code lookup — proxies api.postalpincode.in and enriches with shipping charge
app.get('/api/pincode/:pin', pinLookupRateLimiter, async (req, res) => {
  const pin = String(req.params.pin || '').trim();
  if (!/^[0-9]{6}$/.test(pin)) {
    return res.status(400).json({ valid: false, error: 'Invalid PIN code. Must be 6 digits.' });
  }

  try {
    const postalUrl = `https://api.postalpincode.in/pincode/${pin}`;
    const postalRes = await fetch(postalUrl, { signal: AbortSignal.timeout(8000) });
    if (!postalRes.ok) {
      return res.status(502).json({ valid: false, error: 'Postal API unavailable.' });
    }
    const data = await postalRes.json();
    const block = Array.isArray(data) ? data[0] : null;

    if (!block || block.Status !== 'Success' || !Array.isArray(block.PostOffice) || block.PostOffice.length === 0) {
      return res.status(404).json({ valid: false, error: 'PIN code not found or not serviceable.' });
    }

    const po = block.PostOffice[0];
    const state = po.State || '';
    const district = po.District || '';
    const postOffice = po.Name || '';
    const circle = po.Circle || '';

    // Calculate shipping charge using current rules
    const rules = await readShippingRules();
    const shippingCharge = calculateShippingCharge(state, district, rules);

    return res.json({
      valid: true,
      pin,
      state,
      district,
      postOffice,
      circle,
      shippingCharge,
    });
  } catch {
    console.error('PIN lookup failed.');
    return res.status(502).json({ valid: false, error: 'Unable to look up PIN code. Please try again.' });
  }
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error?.status || error?.statusCode) || 500;
  const safeStatus = [400, 403, 413, 429].includes(status) ? status : 500;
  const message = safeStatus === 413
    ? 'Request body is too large.'
    : safeStatus === 400
      ? 'Invalid request data.'
      : safeStatus === 403
        ? 'Request origin is not allowed.'
        : safeStatus === 429
          ? 'Too many requests. Please try again later.'
          : 'An unexpected server error occurred.';
  if (safeStatus === 500) console.error('Request middleware failed.');
  return res.status(safeStatus).json({ error: message });
});

const port = Number(process.env.PORT || 3001);
console.log('STARTUP PORT:', port);

async function startServer() {
  try {
    if (isPostgresEnabled) {
      console.log('Initializing database on startup...');
      await ensureDatabase();
      console.log('Database initialization complete');
    } else {
      console.log('Using local JSON data store because DATABASE_URL is not configured.');
    }

    const server = app.listen(port, '0.0.0.0', () => {
      console.log('STARTUP: LISTEN CALLBACK REACHED');
      console.log('STARTUP: SERVER ADDRESS:', server.address());
      console.log(`Admin auth server listening on http://0.0.0.0:${port}`);
      if (isPostgresEnabled) {
        console.log('Connected to PostgreSQL via DATABASE_URL');
      }
    });
  } catch {
    console.error('Startup failed during database initialization.');
    process.exit(1);
  }
}

startServer();
