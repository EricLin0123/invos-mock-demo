// routes/stats.js — read-back aggregate endpoints for sanity checks and Grafana (Step 5).
//   GET /api/stats/daily?from&to            -> [{ day, invoice_count, total_amount }]
//   GET /api/stats/category-daily?category= -> [{ day, category, quantity, amount }]
// Plain SQL aggregates over the indexed columns (see migration 002_stats_indexes.sql).

import { pool } from '../db.js';

// Query-string schemas: dates are optional ISO calendar dates; category optional string.
const dailyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
  },
};

const categoryDailyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', minLength: 1 },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
  },
};

export default async function statsRoutes(fastify) {
  // Daily invoice counts and revenue, optionally bounded by [from, to] (inclusive).
  fastify.get('/api/stats/daily', { schema: { querystring: dailyQuery } }, async (request) => {
    const { from, to } = request.query;
    // Build the WHERE clause from whichever bounds were supplied.
    const conds = [];
    const params = [];
    if (from) {
      params.push(from);
      conds.push(`invoice_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conds.push(`invoice_date <= $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT invoice_date::text       AS day,
              count(*)::int            AS invoice_count,
              sum(total_amount)::bigint AS total_amount
         FROM invoices
         ${where}
        GROUP BY invoice_date
        ORDER BY invoice_date`,
      params,
    );
    // sum() comes back as a string for bigint; normalize to number for JSON consumers.
    return rows.map((r) => ({
      day: r.day,
      invoice_count: r.invoice_count,
      total_amount: Number(r.total_amount),
    }));
  });

  // Daily quantity + revenue per category. `category` filters to one category when given;
  // otherwise every category is returned (useful for the campaign comparison in Step 5).
  fastify.get(
    '/api/stats/category-daily',
    { schema: { querystring: categoryDailyQuery } },
    async (request) => {
      const { category, from, to } = request.query;
      const conds = [];
      const params = [];
      if (category) {
        params.push(category);
        conds.push(`ii.category = $${params.length}`);
      }
      if (from) {
        params.push(from);
        conds.push(`i.invoice_date >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conds.push(`i.invoice_date <= $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `SELECT i.invoice_date::text   AS day,
                ii.category            AS category,
                sum(ii.quantity)::bigint AS quantity,
                sum(ii.amount)::bigint   AS amount
           FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
           ${where}
          GROUP BY i.invoice_date, ii.category
          ORDER BY i.invoice_date, ii.category`,
        params,
      );
      return rows.map((r) => ({
        day: r.day,
        category: r.category,
        quantity: Number(r.quantity),
        amount: Number(r.amount),
      }));
    },
  );
}
