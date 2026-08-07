import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const isVercel =
  process.env.VERCEL === '1' ||
  process.env.VERCEL === 'true' ||
  Boolean(process.env.VERCEL_ENV) ||
  Boolean(process.env.NOW_REGION);
const dataDir = isVercel
  ? path.join(os.tmpdir(), 'vasuki-data')
  : path.join(__dirname, '..', 'data');
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

const defaultCredentials = {
  email: 'admin@vasukipickles.com',
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

async function ensureDatabase() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_credentials (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
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
  `);

  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS quantity_type TEXT;
  `);

  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS price_per_unit NUMERIC;
  `);

  await pool.query(`
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      name TEXT,
      product TEXT,
      rating INTEGER,
      date TEXT,
      text TEXT,
      visible BOOLEAN,
      verified_buyer BOOLEAN
    );
  `);

  await pool.query(`
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id SERIAL PRIMARY KEY,
      settings JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_settings (
      id SERIAL PRIMARY KEY,
      settings JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      email TEXT PRIMARY KEY,
      profile JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_profile (
      id SERIAL PRIMARY KEY,
      profile JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_types (
      id SERIAL PRIMARY KEY,
      type TEXT UNIQUE
    );
  `);

  const typeCount = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM product_types');
  if (typeCount.rows[0]?.count === 0) {
    for (const type of defaultProductTypes) {
      await pool.query('INSERT INTO product_types (type) VALUES ($1)', [type]);
    }
  }

  const result = await pool.query('SELECT id FROM admin_credentials LIMIT 1');
  if (result.rowCount === 0) {
    await pool.query(
      'INSERT INTO admin_credentials (email, password) VALUES ($1, $2)',
      [defaultCredentials.email, defaultCredentials.password]
    );
  }

  await seedProductsFromJsonFile();
}

async function ensureDataDirectory() {
  await fs.mkdir(dataDir, { recursive: true });
  console.log('Using JSON data store at:', dataDir);
}

async function ensureStore() {
  if (isPostgresEnabled) {
    await ensureDatabase();
    return;
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
}

async function readCredentials() {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
    const { rows } = await pool.query('SELECT email, password FROM admin_credentials ORDER BY id LIMIT 1');
    return rows[0] || defaultCredentials;
  }

  await ensureStore();
  const raw = await fs.readFile(dataFile, 'utf8');
  return JSON.parse(raw);
}

async function writeCredentials(nextState) {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
    const { rowCount } = await pool.query(
      'UPDATE admin_credentials SET email = $1, password = $2, updated_at = NOW() WHERE id = (SELECT id FROM admin_credentials LIMIT 1);',
      [nextState.email, nextState.password]
    );

    if (rowCount === 0) {
      await pool.query(
        'INSERT INTO admin_credentials (email, password) VALUES ($1, $2)',
        [nextState.email, nextState.password]
      );
    }

    return nextState;
  }

  await ensureStore();
  await fs.writeFile(dataFile, JSON.stringify(nextState, null, 2), 'utf8');
  return nextState;
}

async function readProducts() {
  if (isPostgresEnabled && pool) {
    try {
      await ensureDatabase();
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
      await ensureDatabase();
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
const defaultPaymentSettings = {};
const defaultAdminProfile = {};
const defaultProductTypes = ['Pickles', 'Podis', 'Non-Veg Pickles', 'Sweets & Snacks'];

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
      await ensureDatabase();
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
      await ensureDatabase();
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
    await ensureDatabase();
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
    }));
  }
  return readJsonFile(reviewsFile, defaultReviews);
}

async function writeReviews(nextReviews) {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM reviews');
      for (const review of nextReviews) {
        await pool.query(
          `INSERT INTO reviews (id, name, product, rating, date, text, visible, verified_buyer)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            review.id,
            review.name,
            review.product,
            review.rating,
            review.date,
            review.text,
            review.visible,
            review.verifiedBuyer,
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
    await ensureDatabase();
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
    await ensureDatabase();
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
    await ensureDatabase();
    const { rows } = await pool.query('SELECT settings FROM store_settings ORDER BY id LIMIT 1');
    return rows[0]?.settings || defaultStoreSettings;
  }
  return readJsonFile(storeSettingsFile, defaultStoreSettings);
}

async function writeStoreSettings(nextSettings) {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
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
    await ensureDatabase();
    const { rows } = await pool.query('SELECT settings FROM payment_settings ORDER BY id LIMIT 1');
    return rows[0]?.settings || defaultPaymentSettings;
  }
  return readJsonFile(paymentSettingsFile, defaultPaymentSettings);
}

async function writePaymentSettings(nextSettings) {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
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
    await ensureDatabase();
    const { rows } = await pool.query('SELECT profile FROM admin_profile ORDER BY id LIMIT 1');
    return rows[0]?.profile || defaultAdminProfile;
  }
  return readJsonFile(adminProfileFile, defaultAdminProfile);
}

async function writeAdminProfile(nextProfile) {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
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

async function readProductTypes() {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
    const { rows } = await pool.query('SELECT type FROM product_types ORDER BY id');
    return rows.map((row) => row.type);
  }
  return readJsonFile(productTypesFile, defaultProductTypes);
}

async function writeProductTypes(types) {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
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
    await ensureDatabase();
    const { rows } = await pool.query('SELECT profile FROM user_profiles WHERE email = $1', [email]);
    return rows[0]?.profile || { name: '', email, phone: '', addresses: [], wishlist: [] };
  }
  const data = await readJsonFile(userProfilesFile, {});
  return data[email] || { name: '', email, phone: '', addresses: [], wishlist: [] };
}

async function writeUserProfile(email, profile) {
  if (isPostgresEnabled && pool) {
    await ensureDatabase();
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
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export { app };

app.get('/api/admin-credentials', async (_req, res) => {
  try {
    const credentials = await readCredentials();
    res.json(credentials);
  } catch (error) {
    console.error('Failed to read admin credentials:', error);
    res.status(500).json({ error: 'Unable to read admin credentials.' });
  }
});

app.post('/api/admin-credentials/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const credentials = await readCredentials();

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'A valid current password and a new password of at least 6 characters are required.' });
    }

    if (currentPassword !== credentials.password) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const updated = await writeCredentials({ ...credentials, password: newPassword });
    res.json(updated);
  } catch (error) {
    console.error('Failed to update admin password:', error);
    res.status(500).json({ error: 'Unable to update admin password.' });
  }
});

app.post('/api/admin-credentials/email', async (req, res) => {
  try {
    const { currentPassword, newEmail } = req.body || {};
    const credentials = await readCredentials();

    if (!currentPassword || !newEmail || !newEmail.includes('@')) {
      return res.status(400).json({ error: 'A valid current password and a new email address are required.' });
    }

    if (currentPassword !== credentials.password) {
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

app.post('/api/products', async (req, res) => {
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

app.put('/api/products/:id', async (req, res) => {
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

app.delete('/api/products/:id', async (req, res) => {
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

app.get('/api/orders', async (_req, res) => {
  try {
    const orders = await readOrders();
    res.json(orders);
  } catch (error) {
    console.error('Failed to read orders:', error && error.stack ? error.stack : error);
    res.status(500).json({ error: 'Unable to read orders.' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    console.log('Received order body:', req.body);
    const order = normalizeOrderPayload(req.body || {});
    console.log('Normalized order payload:', order);
    if (!order.customer || !order.items || !Array.isArray(order.items)) {
      return res.status(400).json({ error: 'Order must include customer and items.' });
    }

    const existingOrders = await readOrders();
    const nextOrder = {
      ...order,
      id: order.id || `ORD${Date.now().toString().slice(-8)}`,
      date: order.date || new Date().toISOString(),
      status: order.status || 'Order Placed',
      paymentStatus: order.paymentStatus || 'Pending',
      paymentMethod: order.paymentMethod || 'COD',
      trackingNumber: order.trackingNumber || `TRK${Math.floor(100000 + Math.random() * 900000)}`,
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

app.put('/api/orders/:id', async (req, res) => {
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

app.delete('/api/orders/:id', async (req, res) => {
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

app.get('/api/reviews', async (_req, res) => {
  try {
    const reviews = await readReviews();
    res.json(reviews);
  } catch (error) {
    console.error('Failed to read reviews:', error);
    res.status(500).json({ error: 'Unable to read reviews.' });
  }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const review = req.body || {};
    const reviews = await readReviews();
    const nextReview = {
      ...review,
      id: review.id || `r${Date.now().toString().slice(-8)}`,
      name: review.name || 'Valued Customer',
      product: review.product || '',
      rating: Number(review.rating) || 5,
      date: review.date || new Date().toISOString(),
      visible: review.visible !== undefined ? review.visible : true,
      verifiedBuyer: review.verifiedBuyer !== undefined ? review.verifiedBuyer : true,
      text: review.text || '',
    };
    reviews.unshift(nextReview);
    await writeReviews(reviews);
    res.json(nextReview);
  } catch (error) {
    console.error('Failed to create review:', error);
    res.status(500).json({ error: 'Unable to create review.' });
  }
});

app.delete('/api/reviews/:id', async (req, res) => {
  try {
    const reviews = await readReviews();
    const updatedReviews = reviews.filter((item) => item.id !== req.params.id);
    await writeReviews(updatedReviews);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete review:', error);
    res.status(500).json({ error: 'Unable to delete review.' });
  }
});

app.put('/api/reviews/:id', async (req, res) => {
  try {
    const updates = req.body || {};
    const reviews = await readReviews();
    const index = reviews.findIndex((item) => item.id === req.params.id);
    if (index < 0) {
      return res.status(404).json({ error: 'Review not found.' });
    }
    reviews[index] = {
      ...reviews[index],
      ...updates,
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

app.post('/api/offers', async (req, res) => {
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

app.delete('/api/offers/:id', async (req, res) => {
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

app.post('/api/store-settings', async (req, res) => {
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

app.post('/api/payment-settings', async (req, res) => {
  try {
    const settings = req.body || {};
    const saved = await writePaymentSettings(settings);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save payment settings:', error);
    res.status(500).json({ error: 'Unable to save payment settings.' });
  }
});

app.get('/api/admin-profile', async (_req, res) => {
  try {
    const profile = await readAdminProfile();
    res.json(profile);
  } catch (error) {
    console.error('Failed to read admin profile:', error);
    res.status(500).json({ error: 'Unable to read admin profile.' });
  }
});

app.post('/api/admin-profile', async (req, res) => {
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

app.post('/api/product-types', async (req, res) => {
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

app.get('/api/user-profiles/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const profile = await readUserProfile(email);
    res.json(profile);
  } catch (error) {
    console.error('Failed to read user profile:', error);
    res.status(500).json({ error: 'Unable to read user profile.' });
  }
});

app.post('/api/user-profiles/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const profile = req.body || {};
    const saved = await writeUserProfile(email, profile);
    res.json(saved);
  } catch (error) {
    console.error('Failed to save user profile:', error);
    res.status(500).json({ error: 'Unable to save user profile.' });
  }
});

app.get('/api/customers', async (_req, res) => {
  try {
    const customers = await readCustomers();
    res.json(customers);
  } catch (error) {
    console.error('Failed to read customers:', error);
    res.status(500).json({ error: 'Unable to read customers.' });
  }
});

const port = Number(process.env.PORT || 3001);
if (process.env.VERCEL !== 'true') {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Admin auth server listening on http://127.0.0.1:${port}`);
    if (isPostgresEnabled) {
      console.log('Connected to PostgreSQL via DATABASE_URL');
    } else {
      console.log('Using local JSON data store because DATABASE_URL is not configured.');
    }
  });
}
