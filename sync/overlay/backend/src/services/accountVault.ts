import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";

export type StoredAccount = Record<string, unknown> & { email: string };
export interface AccountEntry {
  account: StoredAccount;
  version: string;
}
export class VaultConflict extends Error {}

// One Node process owns this file. Synchronous read/modify/rename keeps mutations serialized.
export class AccountVault {
  private directory: string;
  private filename: string;
  private keyfile: string;

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "account-vault");
    this.filename = path.join(this.directory, "accounts.enc");
    this.keyfile = path.join(this.directory, "key");
  }

  private key(): Buffer {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    if (!fs.existsSync(this.keyfile)) {
      if (fs.existsSync(this.filename))
        throw new Error("Account vault key is missing");
      fs.writeFileSync(this.keyfile, randomBytes(32), {
        flag: "wx",
        mode: 0o600,
      });
    }
    const key = fs.readFileSync(this.keyfile);
    if (key.length !== 32) throw new Error("Invalid account vault key");
    return key;
  }

  list(): AccountEntry[] {
    const key = this.key();
    if (!fs.existsSync(this.filename)) return [];
    const bytes = fs.readFileSync(this.filename);
    if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== "ASV1")
      throw new Error("Invalid vault");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(4, 16),
    );
    decipher.setAAD(Buffer.from("assppweb-account-vault-v1"));
    decipher.setAuthTag(bytes.subarray(16, 32));
    const entries = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(32)),
        decipher.final(),
      ]).toString(),
    );
    if (!Array.isArray(entries)) throw new Error("Invalid vault");
    return entries;
  }

  private save(entries: AccountEntry[]): void {
    const plain = Buffer.from(JSON.stringify(entries));
    if (plain.length > 8 * 1024 * 1024 || entries.length > 1000)
      throw new Error("Vault capacity exceeded");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from("assppweb-account-vault-v1"));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const bytes = Buffer.concat([
      Buffer.from("ASV1"),
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]);
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filename);
      const directory = fs.openSync(this.directory, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  put(account: StoredAccount, expectedVersion: string | null): AccountEntry[] {
    const entries = this.list();
    const previous = entries.find(
      (item) => item.account.email === account.email,
    );
    if ((previous?.version ?? null) !== expectedVersion)
      throw new VaultConflict();
    const next = entries.filter((item) => item.account.email !== account.email);
    next.push({ account, version: randomUUID() });
    this.save(next);
    return next;
  }

  remove(email: string, expectedVersion: string): AccountEntry[] {
    const entries = this.list();
    if (
      entries.find((item) => item.account.email === email)?.version !==
      expectedVersion
    )
      throw new VaultConflict();
    const next = entries.filter((item) => item.account.email !== email);
    this.save(next);
    return next;
  }
}
