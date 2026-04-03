import "dotenv/config";
import cors from "cors";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3001);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const MAX_AUTH_AGE_SECONDS = 60 * 60 * 24;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing in .env");
}

type TelegramMiniAppUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
};

type DbUser = {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  photoUrl: string | null;
  progress: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
};

type AuthenticatedRequest = Request & {
  dbUser?: DbUser;
};

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function getInitDataFromRequest(req: Request): string {
  const headerValue = req.headers["x-telegram-init-data"];

  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue;
  }

  if (typeof req.body?.initData === "string" && req.body.initData.trim()) {
    return req.body.initData;
  }

  throw new Error("Telegram initData not provided");
}

function parseAndValidateTelegramInitData(initData: string): {
  telegramUser: TelegramMiniAppUser;
  authDate: number;
} {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    throw new Error("Telegram hash is missing");
  }

  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const hashBuffer = Buffer.from(hash, "hex");
  const calculatedHashBuffer = Buffer.from(calculatedHash, "hex");

  if (
    hashBuffer.length !== calculatedHashBuffer.length ||
    !crypto.timingSafeEqual(hashBuffer, calculatedHashBuffer)
  ) {
    throw new Error("Telegram initData is not valid");
  }

  const authDate = Number(params.get("auth_date"));

  if (!Number.isFinite(authDate)) {
    throw new Error("Telegram auth_date is invalid");
  }

  const now = Math.floor(Date.now() / 1000);

  if (now - authDate > MAX_AUTH_AGE_SECONDS) {
    throw new Error("Telegram initData is too old");
  }

  const userRaw = params.get("user");

  if (!userRaw) {
    throw new Error("Telegram user data is missing");
  }

  const telegramUser = JSON.parse(userRaw) as TelegramMiniAppUser;

  if (!telegramUser.id || !telegramUser.first_name) {
    throw new Error("Telegram user data is invalid");
  }

  return { telegramUser, authDate };
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function serializeUser(user: DbUser) {
  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    languageCode: user.languageCode,
    photoUrl: user.photoUrl
  };
}

async function findOrCreateTelegramUser(initData: string): Promise<DbUser> {
  const { telegramUser } = parseAndValidateTelegramInitData(initData);

  const dbUser = await prisma.user.upsert({
    where: {
      telegramId: BigInt(telegramUser.id)
    },
    update: {
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name,
      lastName: telegramUser.last_name ?? null,
      languageCode: telegramUser.language_code ?? null,
      photoUrl: telegramUser.photo_url ?? null
    },
    create: {
      telegramId: BigInt(telegramUser.id),
      username: telegramUser.username ?? null,
      firstName: telegramUser.first_name,
      lastName: telegramUser.last_name ?? null,
      languageCode: telegramUser.language_code ?? null,
      photoUrl: telegramUser.photo_url ?? null,
      progress: {}
    }
  });

  return dbUser;
}

async function requireTelegramAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const initData = getInitDataFromRequest(req);
    const dbUser = await findOrCreateTelegramUser(initData);

    (req as AuthenticatedRequest).dbUser = dbUser;
    next();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unauthorized request";

    res.status(401).json({
      ok: false,
      error: message
    });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    message: "Backend is running"
  });
});

app.post("/api/auth/telegram", async (req, res) => {
  try {
    const initData = getInitDataFromRequest(req);
    const dbUser = await findOrCreateTelegramUser(initData);

    res.json({
      ok: true,
      user: serializeUser(dbUser)
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Telegram auth failed";

    res.status(401).json({
      ok: false,
      error: message
    });
  }
});

app.get("/api/me", requireTelegramAuth, (req, res) => {
  const authReq = req as AuthenticatedRequest;

  res.json({
    ok: true,
    user: serializeUser(authReq.dbUser!)
  });
});

app.get("/api/progress", requireTelegramAuth, (req, res) => {
  const authReq = req as AuthenticatedRequest;

  res.json({
    ok: true,
    progress: authReq.dbUser?.progress ?? {}
  });
});

app.post("/api/progress", requireTelegramAuth, async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const progress = toJsonValue(req.body?.progress ?? {});

    const updatedUser = await prisma.user.update({
      where: {
        id: authReq.dbUser!.id
      },
      data: {
        progress
      }
    });

    res.json({
      ok: true,
      progress: updatedUser.progress
    });
  } catch (error) {
    next(error);
  }
});

app.use(
  (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message =
      error instanceof Error ? error.message : "Internal server error";

    res.status(500).json({
      ok: false,
      error: message
    });
  }
);

app.listen(PORT, () => {
  console.log(`Backend started on http://localhost:${PORT}`);
});