import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function credentialsKey(): Buffer {
  const raw = process.env.ITS_CREDENTIALS_KEY?.trim();
  if (!raw) {
    throw new Error(
      "ITS_CREDENTIALS_KEY не задан. Создайте ключ командой: openssl rand -base64 32",
    );
  }

  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error("ITS_CREDENTIALS_KEY должен содержать ровно 32 байта (base64 или hex)");
  }
  return decoded;
}

export function encryptCredential(value: string): string {
  if (!value) throw new Error("Пустой пароль ИТС нельзя сохранить");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, credentialsKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, encrypted]
    .map((part) => (typeof part === "string" ? part : part.toString("base64")))
    .join(":");
}

export function decryptCredential(payload: string): string {
  const [version, ivRaw, tagRaw, encryptedRaw] = payload.split(":");
  if (version !== VERSION || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Неизвестный формат зашифрованных учётных данных");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    credentialsKey(),
    Buffer.from(ivRaw, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

