import express, { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  AccountVault,
  VaultConflict,
  type StoredAccount,
} from "../services/accountVault.js";

function validAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const account = value as Record<string, unknown>;
  const strings = [
    "email",
    "password",
    "appleId",
    "store",
    "firstName",
    "lastName",
    "passwordToken",
    "directoryServicesIdentifier",
    "deviceIdentifier",
  ];
  if (
    !strings.every(
      (key) =>
        typeof account[key] === "string" &&
        (account[key] as string).length <= 65536,
    )
  )
    return false;
  if (
    !(account.email as string).length ||
    (account.email as string).length > 320
  )
    return false;
  if (!/^[a-fA-F0-9]{12}$/.test(account.deviceIdentifier as string))
    return false;
  if (
    account.pod !== undefined &&
    (typeof account.pod !== "string" || !/^\d{1,6}$/.test(account.pod))
  )
    return false;
  if (
    Object.keys(account).some(
      (key) => ![...strings, "pod", "cookies"].includes(key),
    )
  )
    return false;
  return (
    Array.isArray(account.cookies) &&
    account.cookies.length <= 500 &&
    account.cookies.every(
      (cookie) =>
        cookie &&
        typeof cookie === "object" &&
        typeof cookie.name === "string" &&
        typeof cookie.value === "string" &&
        typeof cookie.path === "string" &&
        typeof cookie.httpOnly === "boolean" &&
        typeof cookie.secure === "boolean" &&
        (cookie.domain === undefined || typeof cookie.domain === "string") &&
        (cookie.expiresAt === undefined ||
          typeof cookie.expiresAt === "number"),
    )
  );
}

export function createAccountsRouter(
  dataDir: string,
  proxyToken: string,
  publicUrl: string,
): Router {
  const router = Router();
  const vault = new AccountVault(dataDir);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store, private");
    res.set("Vary", "Origin");
    const supplied = req.get("X-Asspp-Account-Proxy") || "";
    if (
      !/^[a-f0-9]{64}$/.test(proxyToken) ||
      !/^[a-f0-9]{64}$/.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(proxyToken))
    ) {
      res
        .status(403)
        .json({ error: "账号同步入口未授权，请通过受保护的网页入口访问。" });
      return;
    }
    // Custom header requires a CORS preflight on other origins. This API never enables CORS.
    const origin = req.get("Origin");
    if (
      req.get("X-Asspp-Request") !== "accounts-v1" ||
      req.get("Sec-Fetch-Site") === "cross-site" ||
      (origin && (!publicUrl || origin !== new URL(publicUrl).origin))
    ) {
      res.status(403).json({ error: "拒绝跨站账号请求。" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: "2mb" }));
  router.get("/", (_req, res, next) => {
    try {
      res.json({ entries: vault.list() });
    } catch (error) {
      next(error);
    }
  });
  router.post("/", (req, res, next) => {
    const { account, expectedVersion } = req.body || {};
    if (
      !validAccount(account) ||
      !(
        expectedVersion === null ||
        (typeof expectedVersion === "string" && expectedVersion.length <= 64)
      )
    ) {
      res
        .status(400)
        .json({ error: "账号格式不完整，请重新登录此账号后迁移。" });
      return;
    }
    try {
      res.json({ entries: vault.put(account, expectedVersion) });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/", (req, res, next) => {
    const { email, expectedVersion } = req.body || {};
    if (
      typeof email !== "string" ||
      typeof expectedVersion !== "string" ||
      expectedVersion.length > 64
    ) {
      res.status(400).json({ error: "请求格式无效。" });
      return;
    }
    try {
      res.json({ entries: vault.remove(email, expectedVersion) });
    } catch (error) {
      next(error);
    }
  });
  router.use(
    (
      error: Error & { type?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof VaultConflict) {
        res
          .status(409)
          .json({
            error: "此账号已在另一设备更新或删除。已刷新列表，请重新操作。",
          });
      } else if (error.type === "entity.too.large") {
        res.status(413).json({ error: "账号数据过大。" });
      } else if (error instanceof SyntaxError) {
        res.status(400).json({ error: "请求格式无效。" });
      } else {
        // Never serialize an exception or request body: both can contain Apple credentials.
        res
          .status(503)
          .json({
            error: "服务端账号库暂时不可用；请检查磁盘、账号库及密钥备份。",
          });
      }
    },
  );
  return router;
}
