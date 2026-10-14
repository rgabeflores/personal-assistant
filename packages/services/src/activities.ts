import type { Queryable } from "./db.js";

export type Category = "habit" | "training" | "study" | "other";
export const CATEGORIES: readonly Category[] = ["habit", "training", "study", "other"];

export type Activity = { id: string; slug: string; name: string; category: Category };

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function titleCase(name: string): string {
  return name.trim().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/**
 * Finds an activity by slug, name, or alias, or creates it in the given category.
 * Matching is case-insensitive so "muay thai", "Muay Thai", and "muay_thai" are one activity.
 */
export async function resolveActivity(
  db: Queryable,
  userId: string,
  nameOrSlug: string,
  category: Category,
): Promise<Activity> {
  const slug = slugify(nameOrSlug);
  if (!slug) throw new Error("Activity name is empty");

  const found = await db.query(
    `SELECT id, slug, name, category FROM activities
     WHERE user_id = $1 AND archived_at IS NULL
       AND (slug = $2 OR lower(name) = lower($3) OR lower($3) = ANY (SELECT lower(a) FROM unnest(aliases) a))
     ORDER BY (slug = $2) DESC
     LIMIT 1`,
    [userId, slug, nameOrSlug.trim()],
  );
  if (found.rows[0]) return found.rows[0];

  const created = await db.query(
    `INSERT INTO activities (user_id, category, slug, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id, slug, name, category`,
    [userId, category, slug, titleCase(nameOrSlug)],
  );
  return created.rows[0];
}
