import "dotenv/config";
import cors from "cors";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3001);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const MAX_AUTH_AGE_SECONDS = 60 * 60 * 24;

type Weather = "Солнце" | "Туман" | "Дождь";
type TimeOfDay = "Утро" | "День" | "Вечер";
type InventoryKind =
  | "ingredient"
  | "fish"
  | "aroma"
  | "resource"
  | "misc"
  | "quest"
  | "story";
type AlchemyStage = "idle" | "brewing" | "finalizing" | "success" | "failed";
type TaskCategory = "story" | "daily" | "secret";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSafeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toSafeBoolean(value: unknown): boolean {
  return value === true;
}

function toSafeNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getSingleParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isWeather(value: unknown): value is Weather {
  return value === "Солнце" || value === "Туман" || value === "Дождь";
}

function isTimeOfDay(value: unknown): value is TimeOfDay {
  return value === "Утро" || value === "День" || value === "Вечер";
}

function isInventoryKind(value: unknown): value is InventoryKind {
  return (
    value === "ingredient" ||
    value === "fish" ||
    value === "aroma" ||
    value === "resource" ||
    value === "misc" ||
    value === "quest" ||
    value === "story"
  );
}

function isAlchemyStage(value: unknown): value is AlchemyStage {
  return (
    value === "idle" ||
    value === "brewing" ||
    value === "finalizing" ||
    value === "success" ||
    value === "failed"
  );
}

function isTaskCategory(value: unknown): value is TaskCategory {
  return value === "story" || value === "daily" || value === "secret";
}

function sanitizeInventoryItem(item: unknown) {
  const safeItem = isRecord(item) ? item : {};

  return {
    id: toSafeString(safeItem.id, ""),
    name: toSafeString(safeItem.name, ""),
    kind: isInventoryKind(safeItem.kind) ? safeItem.kind : "misc",
    count: toSafeNumber(safeItem.count, 0, 0, 9999)
  };
}

function sanitizeProgress(progress: unknown) {
  const root = isRecord(progress) ? progress : {};

  const playerRaw = isRecord(root.player) ? root.player : {};
  const worldRaw = isRecord(root.world) ? root.world : {};
  const villageRaw = isRecord(root.village) ? root.village : {};
  const visitedRaw = isRecord(villageRaw.visited) ? villageRaw.visited : {};
  const storyRaw = isRecord(root.story) ? root.story : {};
  const alchemyRaw = isRecord(root.alchemy) ? root.alchemy : {};
  const fishingRaw = isRecord(root.fishing) ? root.fishing : {};

  const inventoryRaw = Array.isArray(root.inventory) ? root.inventory : [];
  const tasksRaw = Array.isArray(root.tasks) ? root.tasks : [];
  const locationsRaw = Array.isArray(root.locations) ? root.locations : [];

  const inventory = inventoryRaw
    .slice(0, 200)
    .map(sanitizeInventoryItem)
    .filter((item) => item.id && item.name);

  const tasks = tasksRaw
    .slice(0, 50)
    .filter(isRecord)
    .map((task) => {
      const rewardItemsRaw = Array.isArray(task.rewardItems) ? task.rewardItems : [];

      return {
        id: toSafeString(task.id, ""),
        title: toSafeString(task.title, ""),
        description: toSafeString(task.description, ""),
        rewardCoins: toSafeNumber(task.rewardCoins, 0, 0, 999999),
        done: toSafeBoolean(task.done),
        claimed: toSafeBoolean(task.claimed),
        category: isTaskCategory(task.category) ? task.category : "story",
        rewardItems: rewardItemsRaw
          .slice(0, 10)
          .map(sanitizeInventoryItem)
          .filter((item) => item.id && item.name),
        unlockComicId: toNullableString(task.unlockComicId),
        nextQuestId: toNullableString(task.nextQuestId)
      };
    })
    .filter((task) => task.id && task.title);

  const locations = locationsRaw
    .slice(0, 50)
    .filter(isRecord)
    .map((location) => ({
      id: toSafeString(location.id, ""),
      title: toSafeString(location.title, ""),
      status: location.status === "Открыто" ? "Открыто" : "Закрыто",
      description: toSafeString(location.description, "")
    }))
    .filter((location) => location.id && location.title);

  const selectedIngredients = (Array.isArray(alchemyRaw.selectedIngredients)
    ? alchemyRaw.selectedIngredients
    : []
  )
    .filter((value): value is string => typeof value === "string")
    .slice(0, 3);

  const unlockedComics = (Array.isArray(storyRaw.unlockedComics)
    ? storyRaw.unlockedComics
    : []
  )
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 100);

  return {
    player: {
      name: toSafeString(playerRaw.name, "Путешественник"),
      coins: toSafeNumber(playerRaw.coins, 120, 0, 999999)
    },
    world: {
      weather: isWeather(worldRaw.weather) ? worldRaw.weather : "Солнце",
      timeOfDay: isTimeOfDay(worldRaw.timeOfDay) ? worldRaw.timeOfDay : "Утро"
    },
    village: {
      visited: {
        keepers: toSafeBoolean(visitedRaw.keepers),
        alchemy: toSafeBoolean(visitedRaw.alchemy),
        workshop: toSafeBoolean(visitedRaw.workshop),
        fishing: toSafeBoolean(visitedRaw.fishing),
        paths: toSafeBoolean(visitedRaw.paths)
      },
      caughtFirstFish: toSafeBoolean(villageRaw.caughtFirstFish),
      brewedFirstAroma: toSafeBoolean(villageRaw.brewedFirstAroma)
    },
    story: {
      unlockedComics,
      firstTrailsGatherDone: toSafeBoolean(storyRaw.firstTrailsGatherDone)
    },
    inventory,
    tasks,
    locations,
    alchemy: {
      heat: toSafeNumber(alchemyRaw.heat, 50, 0, 100),
      selectedIngredients,
      stage: isAlchemyStage(alchemyRaw.stage) ? alchemyRaw.stage : "idle",
      brewProgress: toSafeNumber(alchemyRaw.brewProgress, 0, 0, 100),
      finalHits: toSafeNumber(alchemyRaw.finalHits, 0, 0, 3),
      finalMarkerX: toSafeNumber(alchemyRaw.finalMarkerX, 20, 0, 100),
      finalMarkerDirection:
        typeof alchemyRaw.finalMarkerDirection === "number" &&
        alchemyRaw.finalMarkerDirection < 0
          ? -1
          : 1,
      lastResultName: toNullableString(alchemyRaw.lastResultName)
    },
    fishing: {
      casts: toSafeNumber(fishingRaw.casts, 0, 0, 999999),
      catches: toSafeNumber(fishingRaw.catches, 0, 0, 999999),
      perfectCatches: toSafeNumber(fishingRaw.perfectCatches, 0, 0, 999999),
      lastCatchName: toNullableString(fishingRaw.lastCatchName)
    }
  };
}

function buildProgressSummary(progress: unknown) {
  const safe = sanitizeProgress(progress);

  return {
    coins: safe.player.coins,
    tasksDone: safe.tasks.filter((task) => task.done).length,
    tasksClaimed: safe.tasks.filter((task) => task.claimed).length,
    tasksTotal: safe.tasks.length,
    inventoryItems: safe.inventory.length,
    inventoryCount: safe.inventory.reduce((sum, item) => sum + item.count, 0),
    aromasCount: safe.inventory
      .filter((item) => item.kind === "aroma")
      .reduce((sum, item) => sum + item.count, 0),
    openedLocations: safe.locations.filter(
      (location) => location.status === "Открыто"
    ).length,
    firstFish: safe.village.caughtFirstFish,
    firstAroma: safe.village.brewedFirstAroma,
    alchemyStage: safe.alchemy.stage,
    brewProgress: safe.alchemy.brewProgress,
    finalHits: safe.alchemy.finalHits,
    lastAromaName: safe.alchemy.lastResultName,
    casts: safe.fishing.casts,
    catches: safe.fishing.catches,
    perfectCatches: safe.fishing.perfectCatches,
    lastCatchName: safe.fishing.lastCatchName
  };
}

function getAdminSecretFromRequest(req: Request): string {
  const headerSecret = req.headers["x-admin-secret"];
  const querySecret = req.query.secret;

  if (typeof headerSecret === "string" && headerSecret.trim()) {
    return headerSecret;
  }

  if (typeof querySecret === "string" && querySecret.trim()) {
    return querySecret;
  }

  return "";
}

function requireAdminSecret(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_SECRET) {
    return res.status(500).json({
      ok: false,
      error: "ADMIN_SECRET is missing on server"
    });
  }

  const incomingSecret = getAdminSecretFromRequest(req);

  if (!incomingSecret || incomingSecret !== ADMIN_SECRET) {
    return res.status(403).json({
      ok: false,
      error: "Forbidden"
    });
  }

  next();
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
    progress: sanitizeProgress(authReq.dbUser?.progress ?? {})
  });
});

app.post("/api/progress", requireTelegramAuth, async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const cleanProgress = sanitizeProgress(req.body?.progress ?? {});
    const progress = toJsonValue(cleanProgress);

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
      progress: sanitizeProgress(updatedUser.progress ?? {})
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/users", requireAdminSecret, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: {
        updatedAt: "desc"
      }
    });

    res.json({
      ok: true,
      total: users.length,
      users: users.map((user) => ({
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        languageCode: user.languageCode,
        photoUrl: user.photoUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        summary: buildProgressSummary(user.progress ?? {})
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/users/:id", requireAdminSecret, async (req, res, next) => {
  try {
    const userId = getSingleParam(req.params.id);

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "User id is missing"
      });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: userId
      }
    });

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found"
      });
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        languageCode: user.languageCode,
        photoUrl: user.photoUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        summary: buildProgressSummary(user.progress ?? {})
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/admin/users/:id/progress",
  requireAdminSecret,
  async (req, res, next) => {
    try {
      const userId = getSingleParam(req.params.id);

      if (!userId) {
        return res.status(400).json({
          ok: false,
          error: "User id is missing"
        });
      }

      const user = await prisma.user.findUnique({
        where: {
          id: userId
        }
      });

      if (!user) {
        return res.status(404).json({
          ok: false,
          error: "User not found"
        });
      }

      res.json({
        ok: true,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          username: user.username,
          firstName: user.firstName
        },
        progress: sanitizeProgress(user.progress ?? {})
      });
    } catch (error) {
      next(error);
    }
  }
);

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
