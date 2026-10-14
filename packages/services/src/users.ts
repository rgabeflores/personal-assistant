import type { Queryable } from "./db.js";

export type User = {
  id: string;
  cognitoSub: string;
  displayName: string | null;
  timezone: string;
  profile: Record<string, unknown>;
};

/** Resolves the user from the authenticated identity (INV-7), creating the row on first use. */
export async function ensureUser(db: Queryable, cognitoSub: string, email?: string): Promise<User> {
  const { rows } = await db.query(
    `INSERT INTO users (cognito_sub, email) VALUES ($1, $2)
     ON CONFLICT (cognito_sub) DO UPDATE SET email = COALESCE(users.email, EXCLUDED.email)
     RETURNING id, cognito_sub, display_name, timezone, profile`,
    [cognitoSub, email ?? null],
  );
  const r = rows[0];
  return { id: r.id, cognitoSub: r.cognito_sub, displayName: r.display_name, timezone: r.timezone, profile: r.profile };
}
