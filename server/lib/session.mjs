/* ==================================================================
   session.mjs — プロフィール編集用の短寿命セッション（plan-profile §5）

   HttpOnly クッキーに userId と期限を HMAC で包む。DB は使わない。
   ================================================================== */
import crypto from "node:crypto";
import { loadEnv } from "./env.mjs";

export const COOKIE_NAME = "ks101_edit";
export const TTL_MS = 15 * 60 * 1000;

function secret() {
  loadEnv();
  const s = process.env.LINE_LOGIN_CHANNEL_SECRET;
  if (!s) throw new Error("LINE_LOGIN_CHANNEL_SECRET が未設定です");
  return s;
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload, "utf8").digest("base64url");
}

export function issue(userId) {
  const exp = Date.now() + TTL_MS;
  const body = `${userId}.${exp}`;
  return `${body}.${sign(body)}`;
}

export function verify(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uid, expStr, sig] = parts;
  const body = `${uid}.${expStr}`;
  if (sig !== sign(body)) return null;
  const exp = Number(expStr);
  const userId = Number(uid);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { userId };
}

export function cookieHeader(value) {
  return `${COOKIE_NAME}=${value}; Path=/profile; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/profile; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return null;
}
