import { describe, it, expect, beforeAll } from "vitest";
import { encryptCredential, decryptCredential } from "./crypto.js";

beforeAll(() => {
  process.env.ITS_CREDENTIALS_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
});

describe("encryptCredential / decryptCredential", () => {
  it("round-trips a simple password", () => {
    const password = "my-secret-password";
    const encrypted = encryptCredential(password);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain(password);
    expect(decryptCredential(encrypted)).toBe(password);
  });

  it("round-trips a password with special chars", () => {
    const password = "p@$$w0rd!?<>{}|+=";
    const encrypted = encryptCredential(password);
    expect(decryptCredential(encrypted)).toBe(password);
  });

  it("round-trips an empty-adjacent string", () => {
    const password = "a";
    const encrypted = encryptCredential(password);
    expect(decryptCredential(encrypted)).toBe(password);
  });

  it("round-trips a long password", () => {
    const password = "x".repeat(200);
    const encrypted = encryptCredential(password);
    expect(decryptCredential(encrypted)).toBe(password);
  });

  it("produces different ciphertexts for same input (random IV)", () => {
    const password = "same-password";
    const e1 = encryptCredential(password);
    const e2 = encryptCredential(password);
    expect(e1).not.toBe(e2);
  });

  it("output format has 4 colon-separated parts", () => {
    const encrypted = encryptCredential("test");
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  it("throws on empty input", () => {
    expect(() => encryptCredential("")).toThrow();
    // whitespace-only is not caught by !value guard — acceptable, passwords are trimmed elsewhere
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptCredential("test");
    const parts = encrypted.split(":");
    parts[3] = Buffer.from("00".repeat(16), "hex").toString("base64");
    const tampered = parts.join(":");
    expect(() => decryptCredential(tampered)).toThrow();
  });

  it("throws on unknown format version", () => {
    const encrypted = encryptCredential("test");
    const tampered = encrypted.replace("v1", "v2");
    expect(() => decryptCredential(tampered)).toThrow();
  });

  it("throws on truncated payload", () => {
    expect(() => decryptCredential("v1:abc:def")).toThrow();
  });
});
