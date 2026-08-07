import { promises as fs } from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const workspaceRoot = 'C:/Users/tumur/OneDrive/Documents/me/MY EDU/me/New folder/acharruchipickels/me/vasuki2.0';
dotenv.config({ path: path.join(__dirname, '.env') });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL?.trim(),
  ssl: { rejectUnauthorized: false },
});

const raw = await fs.readFile(path.join(workspaceRoot, 'data', 'products.json'), 'utf8');
const parsed = JSON.parse(raw);
const products = Array.isArray(parsed) ? parsed : [];

await pool.query('DELETE FROM products');

for (const product of products) {
  await pool.query(
    'INSERT INTO products (id, name, category, product_type, quantity_type, weights, spice_level, description, ingredients, shelf_life, discount_price, bulk_price, stock_quantity, in_stock, best_seller, new_arrival, visible, rating, reviews_count, image, additional_images) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)',
    [
      product.id,
      product.name,
      product.category,
      product.productType,
      product.quantityType || 'Weight',
      JSON.stringify(product.weights || []),
      product.spiceLevel,
      product.description,
      product.ingredients,
      product.shelfLife,
      Number(product.discountPrice) || 0,
      Number(product.bulkPrice) || 0,
      Number(product.stockQuantity) || 0,
      Boolean(product.inStock),
      Boolean(product.bestSeller),
      Boolean(product.newArrival),
      product.visible !== false,
      Number(product.rating) || 0,
      Number(product.reviewsCount) || 0,
      product.image || null,
      JSON.stringify(product.additionalImages || []),
    ]
  );
}

const result = await pool.query('SELECT COUNT(*)::INTEGER AS count FROM products');
console.log(JSON.stringify(result.rows[0]));
await pool.end();
