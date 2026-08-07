/* ==================================================================
   repo/oauth-states.mjs — LINE Login の state と用途

   link … ウェブ診断の引き継ぎ（pending_links と同じ state_hash）
   edit … プロフィール編集の本人確認（plan-profile §2）
   ================================================================== */
import { one, run, insertNew } from "./util.mjs";

export const TTL_MINUTES = 30;

export async function create(conn, stateHash, purpose, { now, expiresAt }) {
  if (purpose !== "link" && purpose !== "edit") {
    throw new Error(`未知の purpose: ${purpose}`);
  }
  const ins = await insertNew(conn,
    `INSERT INTO oauth_states (state_hash, purpose, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
    [stateHash, purpose, now, expiresAt]);
  if (!ins.created) throw new Error("state が衝突しました");
  return true;
}

export async function peek(conn, stateHash, { now }) {
  const row = await one(conn,
    `SELECT purpose FROM oauth_states
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    [stateHash, now]);
  return row ? row.purpose : null;
}

export async function consume(conn, stateHash, { now }) {
  const claimed = await run(conn,
    `UPDATE oauth_states
        SET consumed_at = ?
      WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    [now, stateHash, now]);
  if (claimed.affectedRows === 0) return null;

  const row = await one(conn,
    `SELECT purpose FROM oauth_states WHERE state_hash = ?`, [stateHash]);
  return row ? row.purpose : null;
}

export async function purgeExpired(conn, { now }) {
  const r = await run(conn, `DELETE FROM oauth_states WHERE expires_at <= ?`, [now]);
  return r.affectedRows;
}

export async function countExpired(conn, { now }) {
  const row = await one(conn,
    `SELECT COUNT(*) AS n FROM oauth_states WHERE expires_at <= ?`, [now]);
  return row ? Number(row.n) : 0;
}
