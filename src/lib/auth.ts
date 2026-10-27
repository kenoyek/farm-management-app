import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import { pool } from "./db";
const scrypt = promisify(scryptCb);
export const cookieName = "farm_session";
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, stored] = hash.split(":");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(stored, "hex");
  return expected.length === key.length && timingSafeEqual(expected, key);
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    [tokenHash(token), userId],
  );
  return token;
}
export async function sessionUser(
  token: string | undefined,
): Promise<{ id: string; email: string } | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const r = await pool.query(
    "SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [tokenHash(token)],
  );
  return r.rows[0] ?? null;
}
// Fixed dummy hash ensures missing accounts still pay the password-verification cost.
export const dummyPassword =
  "4aa1a7d36d5a1a9aba78c46a8e335b14:" + "00".repeat(64);
