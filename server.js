import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import admin from 'firebase-admin';
import { sendPasswordResetOTP } from './services/emailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

let firebaseAdminInitialized = false;
try {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    firebaseAdminInitialized = true;
    console.log('Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON');
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && privateKey) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: privateKey,
        })
      });
    }
    firebaseAdminInitialized = true;
    console.log('Firebase Admin initialized from environment variables');
  } else {
    console.warn('Firebase Admin credentials not set in environment. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.');
  }
} catch (err) {
  console.error('Firebase Admin initialization error:', err.message);
}

async function verifyFirebaseIdToken(idToken) {
  if (!idToken) throw new Error('Token is required');
  if (firebaseAdminInitialized) {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken;
  } else {
    if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_UNVERIFIED_DEV_TOKENS === 'true') {
      console.warn('DEV WARNING: Firebase Admin not initialized. Decoding unverified token for local dev testing.');
      const decoded = jwt.decode(idToken);
      if (decoded && (decoded.sub || decoded.user_id || decoded.uid)) {
        return {
          uid: decoded.user_id || decoded.sub || decoded.uid,
          phone_number: decoded.phone_number || decoded.phone || '+919999999999',
          email: decoded.email
        };
      }
    }
    throw new Error('Firebase Admin SDK is not initialized on the server.');
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'vasuki_dev_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

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
  email: 'ruchira@gmail.com',
  password: 'Admin@123',
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
  const start = Date.now();
  try {
    console.log('QUERY START', { sql: sql.replace(/\s+/g, ' ').trim().slice(0,200), params });
    const res = await pool.query(sql, params);
    const duration = Date.now() - start;
    console.log('QUERY END', { sql: sql.replace(/\s+/g, ' ').trim().slice(0,200), duration_ms: duration, rowCount: res.rowCount });
    return res;
  } catch (err) {
    const duration = Date.now() - start;
    console.error('QUERY ERROR', { sql: sql.replace(/\s+/g, ' ').trim().slice(0,200), params, duration_ms: duration, message: err && err.message });
    throw err;
  }
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
    quantity: Number(parsedItem?.quantity) || 1,
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

async function seedProductsFromJsonFile() {
  if (!pool) return;

  try {
    const raw = await fs.readFile(productsFile, 'utf8');
    const parsed = JSON.parse(raw);
    const seedProducts = Array.isArray(parsed) ? parsed : [];

    if (seedProducts.length === 0) {
      return;
    }

    // Upsert each seed product so we don't erase admin-created products
    for (const product of seedProducts) {
      try {
        await pool.query(productInsertQuery, productRowParams(normalizeProduct(product)));
      } catch (err) {
        console.warn('Unable to upsert seed product:', product.id || product.name, err && err.message ? err.message : err);
      }
    }
  } catch (error) {
    console.warn('Unable to seed products from data/products.json:', error.message);
  }
}

// Ensure database tables exist and perform necessary seeding with detailed logs
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
      firebase_uid TEXT UNIQUE,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `), 'create users');
  console.log('DB init: users table ready');

  console.log('DB init: adding firebase_uid column to users');
  await withDbTimeout(runQueryLogged(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT UNIQUE;
  `), 'add firebase_uid column');
  console.log('DB init: firebase_uid column ready');

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
  console.log('DB init: seeding products from JSON (async)');
  // Fire-and-forget seeding to avoid blocking startup
  seedProductsFromJsonFile()
    .then(() => console.log('DB init: product seeding completed'))
    .catch(err => console.error('DB init: product seeding error', err));
  console.log('DB init: all init steps completed (excluding product seeding)');
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
    const seedProducts = await readSeededProducts();
    await fs.writeFile(productsFile, JSON.stringify(seedProducts, null, 2), 'utf8');
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
    try {
      const r = await runQueryLogged('SELECT email, password FROM admin_credentials ORDER BY id LIMIT 1');
      return r.rows[0] || defaultCredentials;
    } catch (err) {
      console.error('readCredentials: DB error', err && err.message);
      throw err;
    }
  }

  await ensureStore();
  const raw = await fs.readFile(dataFile, 'utf8');
  return JSON.parse(raw);
}

async function writeCredentials(nextState) {
  // Normalize email and ensure password is hashed before storing
  const email = String(nextState.email || defaultCredentials.email).trim().toLowerCase();
  const password = String(nextState.password || '').trim();
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
      console.error('writeCredentials: DB error', err && err.message);
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
    console.error('normalizeAdminCredentials: initial SELECT error', err && err.message);
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
    console.error('normalizeAdminCredentials: DB error', err && err.message);
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
      if (rows.length > 0) {
        return rows.map(normalizeProduct);
      }

      const seedProducts = await readSeededProducts();
      if (seedProducts.length > 0) {
        try {
          await seedProductsFromJsonFile();
        } catch (seedError) {
          console.warn('Failed to seed Postgres from JSON file:', seedError.message);
        }
        return seedProducts;
      }
    } catch (error) {
      console.warn('Falling back to local products file:', error.message);
    }
  }

  await ensureStore();
  let raw;
  try {
    raw = await fs.readFile(productsFile, 'utf8');
  } catch (readErr) {
    console.warn('readProducts: unable to read products file, falling back to seeded products:', readErr && readErr.message ? readErr.message : readErr);
    const seedProducts = await readSeededProducts();
    try {
      await writeJsonFile(productsFile, seedProducts);
    } catch (writeErr) {
      console.warn('readProducts: failed to write seeded products file:', writeErr && writeErr.message ? writeErr.message : writeErr);
    }
    return seedProducts;
  }

  try {
    const products = JSON.parse(raw);
    return Array.isArray(products) ? products.map(normalizeProduct) : [];
  } catch (error) {
    console.warn('Invalid products file content, seeding from source:', error.message);
    const seedProducts = await readSeededProducts();
    await writeJsonFile(productsFile, seedProducts);
    return seedProducts;
  }
}

async function writeProducts(nextProducts) {
  if (isPostgresEnabled && pool) {
    try {
      
      // Upsert each product individually; do not use a transaction so one failure
      // doesn't abort the entire batch. Log per-row failures and continue.
      for (const product of nextProducts) {
        try {
          await pool.query(productInsertQuery, productRowParams(product));
        } catch (err) {
          console.error('writeProducts: failed upserting product', product.id || product.name, err && err.stack ? err.stack : err);
          // continue to next product instead of throwing to avoid wiping DB
        }
      }
      return nextProducts;
    } catch (error) {
      console.warn('Database write failed, using local products file instead:', error && error.stack ? error.stack : error.message);
    }
  }

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

const seededProductsPaths = [
  path.join(__dirname, '..', 'data', 'products.json'),
  path.join(__dirname, 'data', 'products.json'),
];

async function readSeededProducts() {
  for (const seedPath of seededProductsPaths) {
    try {
      const raw = await fs.readFile(seedPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(normalizeProduct);
      }
    } catch {
      // ignore missing or invalid seed files
    }
  }
  return [];
}

async function readOrders() {
  if (isPostgresEnabled && pool) {
    try {
      
      const { rows } = await pool.query('SELECT * FROM orders ORDER BY date DESC');
      console.log('readOrders: retrieved', rows.length, 'rows from Postgres');
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
    } catch (error) {
      console.warn('Falling back to local orders file:', error && error.stack ? error.stack : error.message);
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
    console.log('writeOrders: using Postgres path; order count =', Array.isArray(nextOrders) ? nextOrders.length : 0);
    try {
      
      await pool.query('BEGIN');
      await pool.query('DELETE FROM orders');
      for (const order of nextOrders) {
        try {
          const customerValue = deepParseJsonValue(order.customer || {});
          const itemsValue = deepParseJsonValue(order.items || []);
          const customerJson = typeof customerValue === 'string' ? JSON.parse(customerValue) : customerValue;
          const itemsJson = typeof itemsValue === 'string' ? JSON.parse(itemsValue) : itemsValue;

          await pool.query(
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
        } catch (rowError) {
          console.error('writeOrders: failed inserting order row:', rowError && rowError.stack ? rowError.stack : rowError, 'order=', JSON.stringify(order));
          throw rowError;
        }
      }
      await pool.query('COMMIT');
      return nextOrders;
    } catch (error) {
      try {
        await pool.query('ROLLBACK');
      } catch (rbErr) {
        console.error('writeOrders: rollback failed:', rbErr && rbErr.stack ? rbErr.stack : rbErr);
      }
      console.error('writeOrders: Database order write failed, falling back to local file. Error:', error && error.stack ? error.stack : error);
      return writeJsonFile(ordersFile, nextOrders);
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
    
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM reviews');
      for (const review of nextReviews) {
        await pool.query(
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
      await pool.query('COMMIT');
      return nextReviews;
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
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
    
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM offers');
      for (const offer of nextOffers) {
        await pool.query(
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
      await pool.query('COMMIT');
      return nextOffers;
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
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
  if (isPostgresEnabled && pool) {
    
    const { rows } = await pool.query('SELECT profile FROM user_profiles WHERE email = $1', [email]);
    return rows[0]?.profile || { name: '', email, phone: '', addresses: [], wishlist: [] };
  }
  const data = await readJsonFile(userProfilesFile, {});
  return data[email] || { name: '', email, phone: '', addresses: [], wishlist: [] };
}

async function writeUserProfile(email, profile) {
  if (isPostgresEnabled && pool) {
    
    const { rowCount } = await pool.query(
      'UPDATE user_profiles SET profile=$1 WHERE email=$2',
      [profile, email]
    );
    if (rowCount === 0) {
      await pool.query('INSERT INTO user_profiles (email, profile) VALUES ($1, $2)', [email, profile]);
    }
    return profile;
  }
  const data = await readJsonFile(userProfilesFile, {});
  data[email] = { ...data[email], ...profile };
  await writeJsonFile(userProfilesFile, data);
  return data[email];
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

const allowedOrigins = [
  'https://ruchira-pickels.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL.trim().replace(/\/$/, ''));
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
  })
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export { app };

app.get('/api/admin-credentials', requireAdmin, async (_req, res) => {
  try {
    const credentials = await readCredentials();
    res.json({ email: credentials.email });
  } catch (error) {
    console.error('Failed to read admin credentials:', error);
    res.status(500).json({ error: 'Unable to read admin credentials.' });
  }
});

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
  try {
    console.log('ROUTE START: /api/admin/login');
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    console.log('Before loading admin credentials');
    const creds = await readCredentials();
    console.log('After loading admin credentials');
    const inputEmail = String(email).trim().toLowerCase();
    const storedEmail = String(creds.email || '').trim().toLowerCase();
    const storedPass = String(creds.password || '');
    const defaultLogin = inputEmail === defaultCredentials.email.toLowerCase() && password === defaultCredentials.password;

    let ok = false;
    if (storedEmail === inputEmail) {
      console.log('Before password comparison');
      if (storedPass.startsWith('$2')) {
        ok = await bcrypt.compare(password, storedPass);
      } else {
        ok = password === storedPass;
        if (ok) {
          await writeCredentials({ email: creds.email, password });
        }
      }
      console.log('After password comparison', { ok });
    }

    console.log('DEBUG: admin compare', { inputEmail, storedEmail, storedPassPrefix: storedPass.slice(0, 4), ok, defaultLogin });

    if (!ok && defaultLogin) {
      // Restore the default admin credentials when the default admin login is used.
      await writeCredentials({ email: defaultCredentials.email, password: defaultCredentials.password });
      ok = true;
    }

    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    console.log('Before JWT generation');
    const token = generateToken({ id: 'admin', email: defaultLogin ? defaultCredentials.email : creds.email, name: 'Administrator', isAdmin: true, role: 'admin' });
    console.log('After JWT generation');
    console.log('Before res.json for admin login');
    const out = { token, email: defaultLogin ? defaultCredentials.email : creds.email, name: 'Administrator' };
    res.json(out);
    console.log('After res.json for admin login');
  } catch (error) {
    console.error('admin login error', error);
    return res.status(500).json({ error: 'Unable to authenticate' });
  }
});

// Protect admin updates — require admin JWT
function requireAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    return next();
  });
}

app.post('/api/admin-credentials/password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const credentials = await readCredentials();

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'A valid current password and a new password of at least 6 characters are required.' });
    }

    const ok = await passwordsMatch(credentials.password, currentPassword);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const updated = await writeCredentials({ ...credentials, password: newPassword });
    res.json(updated);
  } catch (error) {
    console.error('Failed to update admin password:', error);
    res.status(500).json({ error: 'Unable to update admin password.' });
  }
});

app.post('/api/admin-credentials/email', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newEmail } = req.body || {};
    const credentials = await readCredentials();

    if (!currentPassword || !newEmail || !newEmail.includes('@')) {
      return res.status(400).json({ error: 'A valid current password and a new email address are required.' });
    }

    const ok = await passwordsMatch(credentials.password, currentPassword);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const updated = await writeCredentials({ ...credentials, email: newEmail });
    res.json(updated);
  } catch (error) {
    console.error('Failed to update admin email:', error);
    res.status(500).json({ error: 'Unable to update admin email.' });
  }
});

app.get('/api/products', async (_req, res) => {
  try {
    const products = await readProducts();
    res.json(products);
  } catch (error) {
    console.error('Failed to read products:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: 'Unable to read products.' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const products = await readProducts();
    const product = products.find((item) => item.id === req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    res.json(product);
  } catch (error) {
    console.error('Failed to read product:', error);
    res.status(500).json({ error: 'Unable to read product.' });
  }
});

app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const product = req.body || {};
    if (!product.name) {
      return res.status(400).json({ error: 'Product name is required.' });
    }

    const products = await readProducts();
    const nextProduct = {
      ...normalizeProductInput(product),
      id: product.id || Date.now().toString(),
      visible: product.visible !== undefined ? product.visible : true,
      inStock: product.inStock !== undefined ? product.inStock : Number(product.stockQuantity) > 0,
      stockQuantity: Number(product.stockQuantity) || 0,
    };

    products.push(nextProduct);
    await writeProducts(products);
    res.json(nextProduct);
  } catch (error) {
    console.error('Failed to create product:', error);
    res.status(500).json({ error: 'Unable to create product.' });
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const productUpdates = normalizeProductInput(req.body || {});
    const products = await readProducts();
    const index = products.findIndex((item) => item.id === req.params.id);
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

    products[index] = updatedProduct;
    await writeProducts(products);
    res.json(updatedProduct);
  } catch (error) {
    console.error('Failed to update product:', error);
    res.status(500).json({ error: 'Unable to update product.' });
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
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
      } catch (dbErr) {
        console.error('Failed to delete product from Postgres:', dbErr && dbErr.stack ? dbErr.stack : dbErr);
        return res.status(500).json({ error: 'Database error while deleting product.' });
      }
    }

    // Fallback to local JSON store when Postgres is not enabled
    const products = await readProducts();
    const updatedProducts = products.filter((item) => item.id !== prodId);
    await writeProducts(updatedProducts);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete product:', error);
    res.status(500).json({ error: 'Unable to delete product.' });
  }
});

app.get('/api/orders', optionalAuthenticateToken, async (req, res) => {
  try {
    const orders = await readOrders();

    // 1. Admin gets all orders for management
    if (req.user?.isAdmin) {
      return res.json(orders);
    }

    // 2. Authenticated Customer receives ONLY their own orders (isolated by JWT identity)
    if (req.user && req.user.id) {
      const userPhoneDigits = req.user.phone ? String(req.user.phone).replace(/[^0-9]/g, '').slice(-10) : '';
      const userEmailLower = req.user.email ? String(req.user.email).toLowerCase() : '';
      const userId = req.user.id;

      const customerOrders = orders.filter((o) => {
        const cust = o.customer || {};
        const orderPhoneDigits = cust.phone ? String(cust.phone).replace(/[^0-9]/g, '').slice(-10) : '';
        const orderEmailLower = cust.email ? String(cust.email).toLowerCase() : '';

        const matchesUserId = cust.userId && cust.userId === userId;
        const matchesPhone = userPhoneDigits && orderPhoneDigits && userPhoneDigits === orderPhoneDigits;
        const matchesEmail = userEmailLower && orderEmailLower && userEmailLower === orderEmailLower;

        return matchesUserId || matchesPhone || matchesEmail;
      });

      return res.json(customerOrders);
    }

    // 3. Unauthenticated requests return empty array
    return res.json([]);
  } catch (error) {
    console.error('Failed to read orders:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: 'Unable to read orders.' });
  }
});

app.post('/api/orders', optionalAuthenticateToken, async (req, res) => {
  try {
    console.log('Received order request');
    const order = normalizeOrderPayload(req.body || {});
    console.log('Normalized order payload:', order);
    if (!order.customer || !order.items || !Array.isArray(order.items)) {
      return res.status(400).json({ error: 'Order must include customer and items.' });
    }

    // Server attaches verified authenticated customer identity if user is logged in
    if (req.user && !req.user.isAdmin) {
      order.customer.userId = req.user.id;
      if (req.user.phone) order.customer.phone = req.user.phone;
      if (req.user.email && !order.customer.email) order.customer.email = req.user.email;
    }

    // Re-calculate shipping charge server-side — ignore any client-submitted value
    const shippingRules = await readShippingRules();
    const customerState = order.customer?.state || '';
    const customerDistrict = order.customer?.district || '';
    const verifiedShippingCharge = calculateShippingCharge(customerState, customerDistrict, shippingRules);

    // Re-compute totalAmount from items + verified shipping charge
    let itemsSubtotal = 0;
    if (Array.isArray(order.items)) {
      order.items.forEach((item) => {
        itemsSubtotal += (Number(item.weightOption?.price) || 0) * (Number(item.quantity) || 1);
      });
    }
    const verifiedTotal = itemsSubtotal + verifiedShippingCharge;

    const existingOrders = await readOrders();
    const nextOrder = {
      ...order,
      id: order.id || `ORD${Date.now().toString().slice(-8)}`,
      date: order.date || new Date().toISOString(),
      status: order.status || 'Order Placed',
      paymentStatus: order.paymentStatus || 'Pending',
      paymentMethod: order.paymentMethod || 'COD',
      trackingNumber: order.trackingNumber || `TRK${Math.floor(100000 + Math.random() * 900000)}`,
      totalAmount: verifiedTotal,
      customer: {
        ...order.customer,
        shippingCharge: verifiedShippingCharge,
        itemsSubtotal,
        state: customerState,
        district: customerDistrict,
        pincode: order.customer?.pincode || '',
      },
    };

    existingOrders.unshift(nextOrder);
    await writeOrders(existingOrders);
    res.json(nextOrder);
  } catch (error) {
    console.error('Failed to create order:', error);
    console.error('Request body:', req.body);
    res.status(500).json({ error: 'Unable to create order.' });
  }
});

app.put('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const updates = req.body || {};
    const orders = await readOrders();
    const index = orders.findIndex((item) => item.id === req.params.id);
    if (index < 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    orders[index] = {
      ...orders[index],
      ...updates,
      id: req.params.id,
    };
    await writeOrders(orders);
    res.json(orders[index]);
  } catch (error) {
    console.error('Failed to update order:', error);
    res.status(500).json({ error: 'Unable to update order.' });
  }
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const orders = await readOrders();
    const updatedOrders = orders.filter((item) => item.id !== req.params.id);
    await writeOrders(updatedOrders);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete order:', error);
    res.status(500).json({ error: 'Unable to delete order.' });
  }
});

// --- AUTH HELPERS ---
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authenticateToken(req, res, next) {
  const auth = req.headers.authorization || req.query.token || req.headers['x-access-token'];
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuthenticateToken(req, res, next) {
  const auth = req.headers.authorization || req.query.token || req.headers['x-access-token'];
  if (!auth) {
    req.user = null;
    return next();
  }
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    req.user = null;
    return next();
  }
}

// Register user
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log('ROUTE START: /api/auth/register', { isPostgresEnabled, hasPool: Boolean(pool) });
    const { name, email, phone, password } = req.body || {};
    if (!email || !password || !name) return res.status(400).json({ error: 'Missing required fields' });
    const cleanEmail = String(email).trim().toLowerCase();
    // check existing
    if (isPostgresEnabled && pool) {
      console.log('Before checking existing user in Postgres', cleanEmail);
      try {
        const existing = await runQueryLogged('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
        console.log('After checking existing user', { rowCount: existing.rowCount });
        if (existing.rowCount > 0) return res.status(409).json({ error: 'Email already registered' });
      } catch (err) {
        console.error('Error while checking existing user', err && err.message);
        throw err;
      }

      const id = `u${Date.now().toString().slice(-8)}`;
      console.log('Before bcrypt password hashing');
      const hash = await bcrypt.hash(password, 10);
      console.log('After bcrypt password hashing');

      try {
        console.log('Before INSERT query for new user');
        await runQueryLogged('INSERT INTO users (id, name, email, phone, password_hash, is_admin) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, cleanEmail, phone || '', hash, false]);
        console.log('After INSERT query for new user');
      } catch (err) {
        console.error('Error during INSERT of new user', err && err.message);
        throw err;
      }

      console.log('Before JWT generation for new user');
      const token = generateToken({ id, email: cleanEmail, name, isAdmin: false });
      console.log('After JWT generation for new user');
      console.log('Before res.json for register');
      const out = { id, name, email: cleanEmail, token };
      res.json(out);
      console.log('After res.json for register');
      return;
    }

    // JSON fallback
    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    if (profiles[cleanEmail]) return res.status(409).json({ error: 'Email already registered' });
    const id = `u${Date.now().toString().slice(-8)}`;
    const hash = await bcrypt.hash(password, 10);
    profiles[cleanEmail] = { id, name, email: cleanEmail, phone: phone || '', password_hash: hash, created_at: new Date().toISOString() };
    await writeJsonFile(userProfilesFile, profiles);
    const token = generateToken({ id, email: cleanEmail, name, isAdmin: false });
    return res.json({ id, name, email: cleanEmail, token });
  } catch (error) {
    console.error('register error', error);
    res.status(500).json({ error: 'Unable to register' });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });
    const cleanEmail = String(email).trim().toLowerCase();
    if (isPostgresEnabled && pool) {
      const { rows } = await pool.query('SELECT id, name, email, password_hash, is_admin FROM users WHERE LOWER(email) = $1 LIMIT 1', [cleanEmail]);
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, user.password_hash || '');
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      const token = generateToken({ id: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin });
      return res.json({ id: user.id, name: user.name, email: user.email, token });
    } else {
      await ensureStore();
      const profiles = await readJsonFile(userProfilesFile, {});

      const profile = profiles[cleanEmail];
      if (!profile) return res.status(401).json({ error: 'Invalid credentials' });
      const ok = await bcrypt.compare(password, profile.password_hash || '');
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      const token = generateToken({ id: profile.id, email: profile.email, name: profile.name, isAdmin: false });
      return res.json({ id: profile.id, name: profile.name, email: profile.email, token });
    }
  } catch (error) {
    console.error('login error', error);
    res.status(500).json({ error: 'Unable to login' });
  }
});

// Phone + OTP Login via verified Firebase Token
app.post('/api/auth/phone-login', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.body.idToken || req.body.token);

    if (!idToken) {
      return res.status(401).json({ error: 'Authentication token required' });
    }

    const decoded = await verifyFirebaseIdToken(idToken);
    const firebaseUid = decoded.uid;
    const rawPhone = decoded.phone_number || req.body.phone;

    if (!rawPhone) {
      return res.status(400).json({ error: 'Verified phone number missing from authentication token' });
    }

    const cleanPhone = String(rawPhone).trim().replace(/\s+/g, '');
    const digitsOnly = cleanPhone.replace(/^\+91/, '').replace(/[^0-9]/g, '');
    const fullE164 = cleanPhone.startsWith('+') ? cleanPhone : `+91${digitsOnly}`;

    const { name, email } = req.body || {};
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;

    if (isPostgresEnabled && pool) {
      // 1. Try to find user by firebase_uid
      let userRes = await runQueryLogged('SELECT id, name, email, phone, firebase_uid, is_admin FROM users WHERE firebase_uid = $1 LIMIT 1', [firebaseUid]);
      let user = userRes.rows[0];

      // 2. If not found by firebase_uid, try matching by phone number
      if (!user) {
        userRes = await runQueryLogged(
          'SELECT id, name, email, phone, firebase_uid, is_admin FROM users WHERE phone = $1 OR phone = $2 LIMIT 1',
          [fullE164, digitsOnly]
        );
        user = userRes.rows[0];
        
        if (user) {
          // Link firebase_uid to existing user
          await runQueryLogged('UPDATE users SET firebase_uid = $1, updated_at = NOW() WHERE id = $2', [firebaseUid, user.id]);
          user.firebase_uid = firebaseUid;
        }
      }

      // 3. Existing customer found
      if (user) {
        if (name && (!user.name || user.name === 'Customer')) {
          await runQueryLogged('UPDATE users SET name = $1, email = COALESCE(email, $2), updated_at = NOW() WHERE id = $3', [name, cleanEmail, user.id]);
          user.name = name;
          if (cleanEmail) user.email = cleanEmail;
        }

        const appToken = generateToken({
          id: user.id,
          email: user.email || '',
          phone: user.phone || fullE164,
          name: user.name || 'Customer',
          isAdmin: Boolean(user.is_admin)
        });

        return res.json({
          isNewUser: false,
          user: {
            id: user.id,
            name: user.name || 'Customer',
            email: user.email || '',
            phone: user.phone || fullE164,
            isAdmin: Boolean(user.is_admin)
          },
          token: appToken
        });
      }

      // 4. Customer does NOT exist: check if profile name was provided
      if (!name || !String(name).trim()) {
        return res.json({
          isNewUser: true,
          phone: fullE164,
          message: 'Profile completion required'
        });
      }

      // Create new customer account in Postgres
      const newId = `u${Date.now().toString().slice(-8)}`;
      await runQueryLogged(
        'INSERT INTO users (id, name, email, phone, firebase_uid, is_admin) VALUES ($1, $2, $3, $4, $5, $6)',
        [newId, String(name).trim(), cleanEmail || null, fullE164, firebaseUid, false]
      );

      const appToken = generateToken({
        id: newId,
        email: cleanEmail || '',
        phone: fullE164,
        name: String(name).trim(),
        isAdmin: false
      });

      return res.json({
        isNewUser: false,
        user: {
          id: newId,
          name: String(name).trim(),
          email: cleanEmail || '',
          phone: fullE164,
          isAdmin: false
        },
        token: appToken
      });
    }

    // JSON fallback store implementation
    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    
    let profileKey = Object.keys(profiles).find(
      (k) => profiles[k].firebase_uid === firebaseUid || profiles[k].phone === fullE164 || profiles[k].phone === digitsOnly
    );

    if (profileKey) {
      const p = profiles[profileKey];
      p.firebase_uid = firebaseUid;
      if (name && !p.name) p.name = name;
      if (cleanEmail && !p.email) p.email = cleanEmail;
      await writeJsonFile(userProfilesFile, profiles);

      const appToken = generateToken({ id: p.id, email: p.email || '', phone: p.phone || fullE164, name: p.name || 'Customer', isAdmin: false });
      return res.json({
        isNewUser: false,
        user: { id: p.id, name: p.name || 'Customer', email: p.email || '', phone: p.phone || fullE164, isAdmin: false },
        token: appToken
      });
    }

    if (!name || !String(name).trim()) {
      return res.json({ isNewUser: true, phone: fullE164, message: 'Profile completion required' });
    }

    const newId = `u${Date.now().toString().slice(-8)}`;
    const storeKey = cleanEmail || `phone_${digitsOnly}`;
    profiles[storeKey] = {
      id: newId,
      name: String(name).trim(),
      email: cleanEmail || '',
      phone: fullE164,
      firebase_uid: firebaseUid,
      created_at: new Date().toISOString()
    };
    await writeJsonFile(userProfilesFile, profiles);

    const appToken = generateToken({ id: newId, email: cleanEmail || '', phone: fullE164, name: String(name).trim(), isAdmin: false });
    return res.json({
      isNewUser: false,
      user: { id: newId, name: String(name).trim(), email: cleanEmail || '', phone: fullE164, isAdmin: false },
      token: appToken
    });

  } catch (error) {
    console.error('phone-login error:', error);
    return res.status(401).json({ error: error.message || 'Authentication failed' });
  }
});

// Get / update profile
app.get('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    if (req.user?.isAdmin) {
      return res.json({ id: req.user.id, name: req.user.name || 'Administrator', email: req.user.email, phone: '', isAdmin: true });
    }

    const userId = req.user.id;
    const email = req.user.email;
    if (isPostgresEnabled && pool) {
      const { rows } = await pool.query(
        'SELECT id, name, email, phone, is_admin FROM users WHERE id = $1 OR (email IS NOT NULL AND LOWER(email) = $2) LIMIT 1',
        [userId, email?.toLowerCase() || '']
      );
      const u = rows[0];
      if (!u) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: u.id, name: u.name, email: u.email || '', phone: u.phone || '', isAdmin: !!u.is_admin });
    }
    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    const p = Object.values(profiles).find((prof) => prof.id === userId || (email && prof.email?.toLowerCase() === email.toLowerCase())) || profiles[email];
    if (!p) return res.status(404).json({ error: 'Not found' });
    return res.json({ id: p.id, name: p.name, email: p.email || '', phone: p.phone || '', isAdmin: false });
  } catch (error) {
    console.error('profile error', error);
    res.status(500).json({ error: 'Unable to fetch profile' });
  }
});

app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const updates = req.body || {};
    const userId = req.user.id;
    const email = req.user.email;
    if (isPostgresEnabled && pool) {
      const { rows } = await pool.query(
        'SELECT id FROM users WHERE id = $1 OR (email IS NOT NULL AND LOWER(email) = $2) LIMIT 1',
        [userId, email?.toLowerCase() || '']
      );
      const u = rows[0];
      if (!u) return res.status(404).json({ error: 'Not found' });
      const now = new Date().toISOString();
      await pool.query(
        'UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), email = COALESCE($3, email), updated_at = $4 WHERE id = $5',
        [updates.name || null, updates.phone || null, updates.email || null, now, u.id]
      );
      return res.json({ success: true });
    }
    await ensureStore();
    const profiles = await readJsonFile(userProfilesFile, {});
    let key = Object.keys(profiles).find(k => profiles[k].id === userId || (email && profiles[k].email?.toLowerCase() === email.toLowerCase()));
    if (!key && email) key = email;
    if (!key || !profiles[key]) return res.status(404).json({ error: 'Not found' });
    profiles[key].name = updates.name || profiles[key].name;
    profiles[key].phone = updates.phone || profiles[key].phone;
    if (updates.email) profiles[key].email = updates.email;
    profiles[key].updated_at = new Date().toISOString();
    await writeJsonFile(userProfilesFile, profiles);
    return res.json({ success: true });
  } catch (error) {
    console.error('profile update error', error);
    res.status(500).json({ error: 'Unable to update profile' });
  }
});

// ----------------------------------------------------
// EMAIL OTP FORGOT PASSWORD & PASSWORD RESET ENDPOINTS
// ----------------------------------------------------

// 1. Request Password Reset OTP
app.post(['/api/auth/forgot-password', '/api/auth/forgot'], async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !String(email).trim()) {
      return res.status(400).json({ error: 'Email address is required' });
    }
    const cleanEmail = String(email).trim().toLowerCase();

    const genericResponse = {
      success: true,
      message: 'If an account exists for this email, a verification code has been sent.'
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
      // Anti-enumeration: always return generic response
      console.info('Password reset OTP dispatch skipped', { result: 'user_not_found' });
      return res.json(genericResponse);
    }

    // Rate-limiting check: 60 seconds minimum between requests for same email
    if (isPostgresEnabled && pool) {
      const recent = await runQueryLogged(
        "SELECT created_at FROM password_reset_otps WHERE LOWER(email) = $1 AND created_at > NOW() - INTERVAL '60 seconds' LIMIT 1",
        [cleanEmail]
      );
      if (recent.rows.length > 0) {
        return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });
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
          return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });
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
  } catch (error) {
    console.error('forgot-password error:', error);
    return res.status(500).json({ error: 'Unable to process password reset request.' });
  }
});

// 2. Verify Password Reset OTP
app.post('/api/auth/verify-reset-otp', async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 6-digit verification code are required' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    if (cleanOtp.length !== 6 || !/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({ error: 'Verification code must be 6 digits' });
    }

    if (isPostgresEnabled && pool) {
      const { rows } = await runQueryLogged(
        'SELECT id, otp_hash, attempts, max_attempts, expires_at FROM password_reset_otps WHERE LOWER(email) = $1 AND verified = FALSE AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
        [cleanEmail]
      );

      const record = rows[0];
      if (!record) {
        return res.status(400).json({ error: 'Invalid or expired verification code. Please request a new code.' });
      }

      if (record.attempts >= record.max_attempts) {
        return res.status(429).json({ error: 'Maximum verification attempts exceeded. Please request a new code.' });
      }

      // Increment attempt count
      await runQueryLogged('UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = $1', [record.id]);

      const matches = await bcrypt.compare(cleanOtp, record.otp_hash);
      if (!matches) {
        const remaining = record.max_attempts - (record.attempts + 1);
        return res.status(400).json({
          error: remaining > 0 ? `Incorrect verification code. ${remaining} attempts remaining.` : 'Maximum verification attempts exceeded. Please request a new code.'
        });
      }

      // Generate single-use reset token
      const rawResetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = await bcrypt.hash(rawResetToken, 10);

      await runQueryLogged(
        'UPDATE password_reset_otps SET verified = TRUE, reset_token_hash = $1 WHERE id = $2',
        [resetTokenHash, record.id]
      );

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
      delete p.pending_otp_hash;
      delete p.pending_otp_attempts;
      delete p.pending_otp_created;
      await writeJsonFile(userProfilesFile, profiles);

      return res.json({
        success: true,
        resetToken: `${p.id}:${rawResetToken}`
      });
    }
  } catch (error) {
    console.error('verify-reset-otp error:', error);
    return res.status(500).json({ error: 'Unable to verify verification code.' });
  }
});

// 3. Reset Password with Reset Token
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body || {};
    if (!email || !resetToken || !newPassword) {
      return res.status(400).json({ error: 'Missing required parameters.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const parts = resetToken.split(':');
    if (parts.length !== 2) {
      return res.status(400).json({ error: 'Invalid reset session. Please request a new code.' });
    }

    const [recordId, rawToken] = parts;

    if (isPostgresEnabled && pool) {
      const { rows } = await runQueryLogged(
        'SELECT id, reset_token_hash FROM password_reset_otps WHERE id = $1 AND LOWER(email) = $2 AND verified = TRUE AND expires_at > NOW() LIMIT 1',
        [recordId, cleanEmail]
      );

      const record = rows[0];
      if (!record || !record.reset_token_hash) {
        return res.status(400).json({ error: 'Reset session expired or invalid. Please request a new verification code.' });
      }

      const validToken = await bcrypt.compare(rawToken, record.reset_token_hash);
      if (!validToken) {
        return res.status(400).json({ error: 'Invalid reset session.' });
      }

      // Hash new password and update user
      const newHash = await bcrypt.hash(newPassword, 10);
      await runQueryLogged('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE LOWER(email) = $2', [newHash, cleanEmail]);

      // Delete used OTP records
      await runQueryLogged('DELETE FROM password_reset_otps WHERE LOWER(email) = $1', [cleanEmail]);

      return res.json({ success: true, message: 'Password updated successfully. Please log in with your new password.' });
    } else {
      await ensureStore();
      const profiles = await readJsonFile(userProfilesFile, {});
      const p = profiles[cleanEmail];
      if (!p || !p.reset_token_hash) {
        return res.status(400).json({ error: 'Reset session expired or invalid.' });
      }

      const validToken = await bcrypt.compare(rawToken, p.reset_token_hash);
      if (!validToken) {
        return res.status(400).json({ error: 'Invalid reset session.' });
      }

      p.password_hash = await bcrypt.hash(newPassword, 10);
      delete p.reset_token_hash;
      p.updated_at = new Date().toISOString();
      await writeJsonFile(userProfilesFile, profiles);

      return res.json({ success: true, message: 'Password updated successfully. Please log in.' });
    }
  } catch (error) {
    console.error('reset-password error:', error);
    return res.status(500).json({ error: 'Unable to reset password.' });
  }
});

app.post('/api/auth/reset', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.length < 8) {
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
  } catch (error) {
    console.error('reset password error', error);
    res.status(500).json({ error: 'Unable to reset password.' });
  }
});

app.get('/api/reviews', async (_req, res) => {
  try {
    const reviews = await readReviews();
    res.json(reviews);
  } catch (error) {
    console.error('Failed to read reviews:', error);
    res.status(500).json({ error: 'Unable to read reviews.' });
  }
});

// Create a review (requires auth)
app.post('/api/reviews', authenticateToken, async (req, res) => {
  try {
    const review = req.body || {};
    const reviews = await readReviews();
    const userId = req.user.id;
    const userEmail = req.user.email;
    const userName = req.user.name || req.user.email;

    // Prevent duplicate review by same user for same product
    const exists = reviews.find((r) => r.product === review.product && (r.user_id === userId || r.user_email === userEmail));
    if (exists) {
      return res.status(409).json({ error: 'User has already reviewed this product' });
    }

    const now = new Date().toISOString();
    const nextReview = {
      ...review,
      id: review.id || `r${Date.now().toString().slice(-8)}`,
      name: userName,
      product: review.product || '',
      rating: Number(review.rating) || 5,
      date: now,
      visible: review.visible !== undefined ? review.visible : true,
      verifiedBuyer: review.verifiedBuyer !== undefined ? review.verifiedBuyer : true,
      text: review.text || '',
      user_id: userId,
      user_email: userEmail,
      user_name: userName,
      created_at: now,
      updated_at: now,
    };
    reviews.unshift(nextReview);
    await writeReviews(reviews);
    res.json(nextReview);
  } catch (error) {
    console.error('Failed to create review:', error);
    res.status(500).json({ error: 'Unable to create review.' });
  }
});

// Delete review (auth + ownership or admin)
app.delete('/api/reviews/:id', authenticateToken, async (req, res) => {
  try {
    const reviews = await readReviews();
    const index = reviews.findIndex((item) => item.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Review not found' });
    const target = reviews[index];
    const isOwner = req.user.isAdmin || (target.user_id && target.user_id === req.user.id) || (target.user_email && target.user_email === req.user.email);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
    const updated = reviews.filter((item) => item.id !== req.params.id);
    await writeReviews(updated);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete review:', error);
    res.status(500).json({ error: 'Unable to delete review.' });
  }
});

// Update review (auth + ownership or admin)
app.put('/api/reviews/:id', authenticateToken, async (req, res) => {
  try {
    const updates = req.body || {};
    const reviews = await readReviews();
    const index = reviews.findIndex((item) => item.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Review not found' });
    const target = reviews[index];
    const isOwner = req.user.isAdmin || (target.user_id && target.user_id === req.user.id) || (target.user_email && target.user_email === req.user.email);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
    const now = new Date().toISOString();
    reviews[index] = {
      ...reviews[index],
      ...updates,
      updated_at: now,
      id: req.params.id,
    };
    await writeReviews(reviews);
    res.json(reviews[index]);
  } catch (error) {
    console.error('Failed to update review:', error);
    res.status(500).json({ error: 'Unable to update review.' });
  }
});

app.get('/api/offers', async (_req, res) => {
  try {
    const offers = await readOffers();
    res.json(offers);
  } catch (error) {
    console.error('Failed to read offers:', error);
    res.status(500).json({ error: 'Unable to read offers.' });
  }
});

app.post('/api/offers', requireAdmin, async (req, res) => {
  try {
    const offer = req.body || {};
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
  } catch (error) {
    console.error('Failed to save offer:', error);
    res.status(500).json({ error: 'Unable to save offer.' });
  }
});

app.delete('/api/offers/:id', requireAdmin, async (req, res) => {
  try {
    const offers = await readOffers();
    const updatedOffers = offers.filter((item) => item.id !== req.params.id);
    await writeOffers(updatedOffers);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete offer:', error);
    res.status(500).json({ error: 'Unable to delete offer.' });
  }
});

app.get('/api/store-settings', async (_req, res) => {
  try {
    const settings = await readStoreSettings();
    res.json(settings);
  } catch (error) {
    console.error('Failed to read store settings:', error);
    res.status(500).json({ error: 'Unable to read store settings.' });
  }
});

app.post('/api/store-settings', requireAdmin, async (req, res) => {
  try {
    const settings = req.body || {};
    const saved = await writeStoreSettings(settings);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save store settings:', error);
    res.status(500).json({ error: 'Unable to save store settings.' });
  }
});

app.get('/api/payment-settings', async (_req, res) => {
  try {
    const settings = await readPaymentSettings();
    res.json(settings);
  } catch (error) {
    console.error('Failed to read payment settings:', error);
    res.status(500).json({ error: 'Unable to read payment settings.' });
  }
});

app.post('/api/payment-settings', requireAdmin, async (req, res) => {
  try {
    const settings = req.body || {};
    const saved = await writePaymentSettings(settings);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save payment settings:', error);
    res.status(500).json({ error: 'Unable to save payment settings.' });
  }
});

app.get('/api/admin-profile', requireAdmin, async (_req, res) => {
  try {
    const profile = await readAdminProfile();
    res.json(profile);
  } catch (error) {
    console.error('Failed to read admin profile:', error);
    res.status(500).json({ error: 'Unable to read admin profile.' });
  }
});

app.post('/api/admin-profile', requireAdmin, async (req, res) => {
  try {
    const profile = req.body || {};
    const saved = await writeAdminProfile(profile);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save admin profile:', error);
    res.status(500).json({ error: 'Unable to save admin profile.' });
  }
});

app.get('/api/product-types', async (_req, res) => {
  try {
    const types = await readProductTypes();
    res.json(types);
  } catch (error) {
    console.error('Failed to read product types:', error);
    res.status(500).json({ error: 'Unable to read product types.' });
  }
});

app.post('/api/product-types', requireAdmin, async (req, res) => {
  try {
    const types = req.body || [];
    if (!Array.isArray(types)) {
      return res.status(400).json({ error: 'Product types must be an array.' });
    }
    const saved = await writeProductTypes(types);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save product types:', error);
    res.status(500).json({ error: 'Unable to save product types.' });
  }
});

app.get('/api/user-profiles/:email', authenticateToken, async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!req.user.isAdmin && req.user.email !== email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const profile = await readUserProfile(email);
    res.json(profile);
  } catch (error) {
    console.error('Failed to read user profile:', error);
    res.status(500).json({ error: 'Unable to read user profile.' });
  }
});

app.post('/api/user-profiles/:email', authenticateToken, async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!req.user.isAdmin && req.user.email !== email) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const profile = req.body || {};
    const saved = await writeUserProfile(email, profile);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save user profile:', error);
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
  } catch (error) {
    console.error('Failed to read customers:', error);
    res.status(500).json({ error: 'Unable to read customers.' });
  }
});

// --- SHIPPING RULES ---

app.get('/api/shipping-rules', async (_req, res) => {
  try {
    const rules = await readShippingRules();
    res.json(rules);
  } catch (error) {
    console.error('Failed to read shipping rules:', error);
    res.status(500).json({ error: 'Unable to read shipping rules.' });
  }
});

app.post('/api/shipping-rules', requireAdmin, async (req, res) => {
  try {
    const rules = req.body || {};
    const saved = await writeShippingRules(rules);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save shipping rules:', error);
    res.status(500).json({ error: 'Unable to save shipping rules.' });
  }
});

// PIN code lookup — proxies api.postalpincode.in and enriches with shipping charge
app.get('/api/pincode/:pin', async (req, res) => {
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
  } catch (error) {
    console.error('PIN lookup error:', error && error.message);
    return res.status(502).json({ valid: false, error: 'Unable to look up PIN code. Please try again.' });
  }
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
  } catch (err) {
    console.error('Startup failed during database initialization:', err && (err.stack || err.message || err));
    process.exit(1);
  }
}

startServer();
