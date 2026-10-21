import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDB } from "idb";
import type { Account } from "../../src/types";

const account: Account = {
  email: "test@example.com",
  password: "fixture",
  appleId: "test",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "old-token",
  directoryServicesIdentifier: "dsid",
  cookies: [],
  deviceIdentifier: "012345abcdef",
};
let entries: { account: Account; version: string }[];
let revision: number;
let offline: boolean;
async function client() {
  vi.resetModules();
  return (await import("../../src/store/accounts")).useAccountsStore;
}
beforeEach(async () => {
  entries = [];
  revision = 0;
  offline = false;
  const db = await openDB("asspp-accounts", 1, {
    upgrade(db) {
      db.createObjectStore("accounts", { keyPath: "email" });
    },
  });
  await db.clear("accounts");
  db.close();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (offline) throw new Error("network down");
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.headers["X-Asspp-Request"]).toBe("accounts-v1");
      const body = init.body && JSON.parse(init.body);
      if (init.method === "POST" || init.method === "DELETE") {
        const email = body.account?.email || body.email;
        const current = entries.find((entry) => entry.account.email === email);
        if ((current?.version ?? null) !== body.expectedVersion)
          return new Response(JSON.stringify({ error: "conflict" }), {
            status: 409,
          });
        entries = entries.filter((entry) => entry.account.email !== email);
        if (init.method === "POST")
          entries.push({ account: body.account, version: String(++revision) });
      }
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }),
  );
});

describe("cross-device server accounts", () => {
  it("loads a saved session in a separate client without storing it in IndexedDB", async () => {
    const desktop = await client();
    await desktop.getState().addAccount(account);
    const phone = await client();
    await phone.getState().loadAccounts();
    expect(phone.getState().accounts[0].passwordToken).toBe("old-token");
    const db = await openDB("asspp-accounts", 1);
    expect(await db.getAll("accounts")).toEqual([]);
    db.close();
  });
  it("rejects a stale second device and refreshes it without losing the new session", async () => {
    const desktop = await client();
    await desktop.getState().addAccount(account);
    const phone = await client();
    await phone.getState().loadAccounts();
    const stale = {
      ...phone.getState().accounts[0],
      passwordToken: "stale-token",
    };
    await desktop
      .getState()
      .updateAccount({
        ...desktop.getState().accounts[0],
        passwordToken: "fresh-token",
      });
    await expect(phone.getState().updateAccount(stale)).rejects.toThrow(
      "conflict",
    );
    expect(phone.getState().accounts[0].passwordToken).toBe("fresh-token");
    expect(entries[0].account.passwordToken).toBe("fresh-token");
  });
  it("does not resurrect deleted accounts after background synchronization", async () => {
    const desktop = await client();
    await desktop.getState().addAccount(account);
    const phone = await client();
    await phone.getState().loadAccounts();
    const stale = { ...phone.getState().accounts[0] };
    await desktop.getState().removeAccount(account.email);
    await phone.getState().loadAccounts();
    await expect(phone.getState().updateAccount(stale)).rejects.toThrow(
      "conflict",
    );
    expect(entries).toEqual([]);
  });
  it("keeps revision on account spreads and advances it after sequential updates", async () => {
    const desktop = await client();
    await desktop.getState().addAccount(account);
    const next = {
      ...desktop.getState().accounts[0],
      passwordToken: "renewed",
    };
    await desktop.getState().updateAccount(next);
    await desktop.getState().updateAccount({ ...next, cookies: [] });
    expect(entries[0].account.passwordToken).toBe("renewed");
    expect(revision).toBe(3);
  });
  it("migrates local-only accounts explicitly and preserves conflicting local records", async () => {
    const db = await openDB("asspp-accounts", 1);
    await db.put("accounts", account);
    await db.put("accounts", { ...account, email: "second@example.com" });
    const desktop = await client();
    await desktop
      .getState()
      .addAccount({ ...account, passwordToken: "server-token" });
    await desktop.getState().loadAccounts();
    expect(desktop.getState().legacyCount).toBe(2);
    await desktop.getState().migrateLocalAccounts();
    expect(entries).toHaveLength(2);
    expect(
      entries.find((item) => item.account.email === account.email)?.account
        .passwordToken,
    ).toBe("server-token");
    expect(await db.count("accounts")).toBe(1);
    expect(await db.get("accounts", account.email)).toBeDefined();
    db.close();
  });
  it("keeps local data intact on a failed migration and reports server failures", async () => {
    const db = await openDB("asspp-accounts", 1);
    await db.put("accounts", account);
    const desktop = await client();
    offline = true;
    await expect(desktop.getState().migrateLocalAccounts()).rejects.toThrow(
      "无法连接",
    );
    expect(await db.count("accounts")).toBe(1);
    db.close();
    await desktop.getState().loadAccounts();
    expect(desktop.getState().syncError).toContain("无法连接");
    expect(desktop.getState().loading).toBe(false);
  });
});
