import { beforeEach, afterEach, describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountsRouter } from "../../src/routes/accounts.js";
import { AccountVault } from "../../src/services/accountVault.js";

const token = "1".repeat(64);
const headers = {
  "X-Asspp-Account-Proxy": token,
  "X-Asspp-Request": "accounts-v1",
};
const account = {
  email: "fixture@example.com",
  password: "only-a-test-password",
  appleId: "fixture",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "test-token",
  directoryServicesIdentifier: "test-dsid",
  cookies: [],
  deviceIdentifier: "012345abcdef",
  pod: "25",
};
let directory: string;
function app(secret = token) {
  const server = express();
  server.use(
    "/api/accounts",
    createAccountsRouter(directory, secret, "https://apps.example.com"),
  );
  return server;
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "asspp-vault-test-"));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("server account vault", () => {
  it("denies missing, wrong and disabled proxy authentication", async () => {
    for (const secret of [token, ""]) {
      expect((await request(app(secret)).get("/api/accounts")).status).toBe(
        403,
      );
    }
    expect(
      (
        await request(app())
          .get("/api/accounts")
          .set({ ...headers, "X-Asspp-Account-Proxy": "2".repeat(64) })
      ).status,
    ).toBe(403);
    expect(fs.existsSync(path.join(directory, "account-vault"))).toBe(false);
  });
  it("rejects cross-origin and simple CSRF requests", async () => {
    expect(
      (
        await request(app())
          .post("/api/accounts")
          .set("X-Asspp-Account-Proxy", token)
          .send({ account, expectedVersion: null })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .get("/api/accounts")
          .set(headers)
          .set("Origin", "https://evil.example.com")
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app())
          .get("/api/accounts")
          .set(headers)
          .set("Sec-Fetch-Site", "cross-site")
      ).status,
    ).toBe(403);
  });
  it("persists encrypted sessions across server instances with private permissions", async () => {
    const created = await request(app())
      .post("/api/accounts")
      .set(headers)
      .send({ account, expectedVersion: null });
    expect(created.status).toBe(200);
    const result = await request(app()).get("/api/accounts").set(headers);
    expect(result.body.entries[0].account).toEqual(account);
    expect(result.headers["cache-control"]).toContain("no-store");
    const file = path.join(directory, "account-vault/accounts.enc");
    const contents = fs.readFileSync(file);
    for (const secret of [
      account.email,
      account.password,
      account.passwordToken,
    ])
      expect(contents.includes(Buffer.from(secret))).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(directory, "account-vault/key")).mode & 0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(directory, "account-vault")).mode & 0o777,
    ).toBe(0o700);
  });
  it("rejects stale updates and never resurrects a deleted account", async () => {
    const vault = new AccountVault(directory);
    const old = vault.put(account, null)[0];
    const updated = vault.put(
      { ...account, passwordToken: "new-session" },
      old.version,
    )[0];
    const stale = await request(app())
      .post("/api/accounts")
      .set(headers)
      .send({ account, expectedVersion: old.version });
    expect(stale.status).toBe(409);
    vault.remove(account.email, updated.version);
    expect(
      (
        await request(app())
          .post("/api/accounts")
          .set(headers)
          .send({ account, expectedVersion: updated.version })
      ).status,
    ).toBe(409);
    expect(vault.list()).toEqual([]);
  });
  it("preserves unrelated accounts and serializes concurrent creation", async () => {
    const responses = await Promise.all(
      ["a", "b"].map((name) =>
        request(app())
          .post("/api/accounts")
          .set(headers)
          .send({
            account: { ...account, email: name + "@example.com" },
            expectedVersion: null,
          }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const entries = new AccountVault(directory).list();
    expect(entries).toHaveLength(2);
    const deleted = await request(app())
      .delete("/api/accounts")
      .set(headers)
      .send({
        email: entries[0].account.email,
        expectedVersion: entries[0].version,
      });
    expect(deleted.body.entries).toHaveLength(1);
  });
  it("fails closed without regenerating a missing key or overwriting damaged data", async () => {
    new AccountVault(directory).put(account, null);
    const file = path.join(directory, "account-vault/accounts.enc");
    const original = fs.readFileSync(file);
    fs.unlinkSync(path.join(directory, "account-vault/key"));
    expect(
      (await request(app()).get("/api/accounts").set(headers)).status,
    ).toBe(503);
    expect(fs.existsSync(path.join(directory, "account-vault/key"))).toBe(
      false,
    );
    expect(fs.readFileSync(file)).toEqual(original);
  });
  it("detects ciphertext tampering and rejects writes", async () => {
    new AccountVault(directory).put(account, null);
    const file = path.join(directory, "account-vault/accounts.enc");
    const modified = fs.readFileSync(file);
    modified[modified.length - 1] ^= 1;
    fs.writeFileSync(file, modified);
    const response = await request(app())
      .post("/api/accounts")
      .set(headers)
      .send({ account, expectedVersion: null });
    expect(response.status).toBe(503);
    expect(response.text).not.toContain(account.password);
    expect(fs.readFileSync(file)).toEqual(modified);
  });
  it("validates accounts and does not echo malformed request secrets", async () => {
    expect(
      (
        await request(app())
          .post("/api/accounts")
          .set(headers)
          .send({
            account: { ...account, deviceIdentifier: "" },
            expectedVersion: null,
          })
      ).status,
    ).toBe(400);
    const invalid = await request(app())
      .post("/api/accounts")
      .set(headers)
      .set("Content-Type", "application/json")
      .send('{"password":"private-broken-json');
    expect(invalid.status).toBe(400);
    expect(invalid.text).not.toContain("private-broken-json");
    expect(
      (
        await request(app())
          .post("/api/accounts")
          .set(headers)
          .send({ payload: "x".repeat(2 * 1024 * 1024) })
      ).status,
    ).toBe(413);
  });
});
