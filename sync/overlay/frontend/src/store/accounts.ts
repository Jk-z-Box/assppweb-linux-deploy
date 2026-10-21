import { create } from "zustand";
import { openDB } from "idb";
import type { Account } from "../types";

interface AccountEntry {
  account: Account;
  version: string;
}
interface AccountsState {
  accounts: Account[];
  loading: boolean;
  syncError: string;
  legacyCount: number;
  loadAccounts: () => Promise<void>;
  addAccount: (account: Account) => Promise<void>;
  updateAccount: (account: Account) => Promise<void>;
  removeAccount: (email: string) => Promise<void>;
  migrateLocalAccounts: () => Promise<void>;
}

// Kept only in memory. No server credentials or Apple sessions are written to browser storage.
const versions = new WeakMap<Account, string>();
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.catch(() => undefined);
  return result;
}

async function request(
  method = "GET",
  body?: unknown,
): Promise<AccountEntry[]> {
  let response: Response;
  try {
    response = await fetch("/api/accounts", {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "X-Asspp-Request": "accounts-v1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("无法连接服务端账号库，请检查网络后重试。");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "账号同步失败，请重新打开网页登录入口。"),
      { status: response.status },
    );
  if (!Array.isArray(data.entries))
    throw new Error("服务端未启用账号同步，请先升级。");
  return data.entries;
}

async function legacyDatabase() {
  return openDB("asspp-accounts", 1, {
    upgrade(db) {
      db.createObjectStore("accounts", { keyPath: "email" });
    },
  });
}

export const useAccountsStore = create<AccountsState>((set, get) => {
  const accept = (entries: AccountEntry[]) => {
    const previous = get().accounts;
    const accounts = entries.map((entry) => {
      const unchanged = previous.find(
        (item) =>
          item.email === entry.account.email &&
          versions.get(item) === entry.version,
      );
      if (unchanged) return unchanged;
      versions.set(entry.account, entry.version);
      return entry.account;
    });
    const unchanged =
      accounts.length === previous.length &&
      accounts.every((item, index) => item === previous[index]);
    set({
      accounts: unchanged ? previous : accounts,
      syncError: "",
      loading: false,
    });
  };
  const reload = async () => {
    try {
      accept(await request());
    } catch (error) {
      const status = (error as { status?: number }).status;
      set({
        syncError: (error as Error).message,
        loading: false,
        ...(status === 401 || status === 403 ? { accounts: [] } : {}),
      });
      throw error;
    }
  };
  const mutate = async (method: string, body: unknown) => {
    try {
      accept(await request(method, body));
    } catch (error) {
      if ((error as { status?: number }).status === 409)
        await reload().catch(() => undefined);
      set({ syncError: (error as Error).message });
      throw error;
    }
  };
  return {
    accounts: [],
    loading: true,
    syncError: "",
    legacyCount: 0,
    loadAccounts: () =>
      serial(async () => {
        await reload().catch(() => undefined);
        try {
          const db = await legacyDatabase();
          set({ legacyCount: await db.count("accounts") });
          db.close();
        } catch {
          /* Private browsing can disable local storage; server sync still works. */
        }
      }),
    addAccount: (account) =>
      serial(() => {
        const existing = get().accounts.find(
          (item) => item.email === account.email,
        );
        return mutate("POST", {
          account,
          expectedVersion: existing ? versions.get(existing) : null,
        });
      }),
    updateAccount: (account) =>
      serial(async () => {
        // Call sites pass a copy of an account. Its hidden revision is retained as an enumerable
        // Symbol by object spread, but JSON serialization never sends it as an account field.
        const expectedVersion =
          (account as VersionedAccount)[accountRevision] ||
          versions.get(account);
        if (!expectedVersion)
          throw new Error("账号版本已失效，请刷新页面后重试。");
        await mutate("POST", { account, expectedVersion });
        const saved = get().accounts.find(
          (item) => item.email === account.email,
        );
        if (saved)
          (account as VersionedAccount)[accountRevision] = versions.get(saved);
      }),
    removeAccount: (email) =>
      serial(async () => {
        const account = get().accounts.find((item) => item.email === email);
        if (!account) return;
        await mutate("DELETE", {
          email,
          expectedVersion: versions.get(account),
        });
      }),
    migrateLocalAccounts: () =>
      serial(async () => {
        await reload();
        const db = await legacyDatabase();
        try {
          const local = (await db.getAll("accounts")) as Account[];
          let moved = 0;
          for (const account of local) {
            // Existing server sessions win. Do not silently replace them with old local sessions.
            if (get().accounts.some((item) => item.email === account.email))
              continue;
            await mutate("POST", { account, expectedVersion: null });
            // Delete only the exact local record successfully copied; preserve concurrent local edits.
            const tx = db.transaction("accounts", "readwrite");
            const current = await tx.store.get(account.email);
            if (JSON.stringify(current) === JSON.stringify(account))
              await tx.store.delete(account.email);
            await tx.done;
            moved++;
          }
          const remaining = await db.count("accounts");
          set({
            legacyCount: remaining,
            syncError: remaining
              ? `已迁移 ${moved} 个账号；其余本机账号与服务端重名，已保留本机副本，未覆盖服务端。`
              : "",
          });
        } finally {
          db.close();
        }
      }),
  };
});

const accountRevision = Symbol("server-account-revision");
type VersionedAccount = Account & { [accountRevision]?: string };
useAccountsStore.subscribe((state) => {
  for (const account of state.accounts) {
    const version = versions.get(account);
    if (version) (account as VersionedAccount)[accountRevision] = version;
  }
});
