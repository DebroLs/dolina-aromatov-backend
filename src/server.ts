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
const SYSTEM_TELEGRAM_ID = BigInt(0);
const DEFAULT_PLAYER_NAME = "Путешественник";
const DEFAULT_PLAYER_COINS = 120;
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
type GlobalWorldSettings = {
  weather: Weather;
  timeOfDay: TimeOfDay;
  eventName: string;
};
type SystemStatusSettings = {
  maintenanceEnabled: boolean;
  title: string;
  message: string;
  targetSegments: string[];
};
type SystemAnnouncementSettings = {
  enabled: boolean;
  title: string;
  message: string;
  targetSegments: string[];
};
type AdminLogEntry = {
  id: string;
  at: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  details: Record<string, unknown>;
};
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
class BannedError extends Error {
  constructor() {
    super("Player is banned");
    this.name = "BannedError";
  }
}
class MaintenanceError extends Error {
  status: SystemStatusSettings;

  constructor(status: SystemStatusSettings) {
    super(status.title || "Технические работы");
    this.name = "MaintenanceError";
    this.status = status;
  }
}
app.use(cors());
app.use(express.json({ limit: "8mb" }));
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
function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function parseAdminNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return null;
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
function sanitizeGlobalWorldSettings(value: unknown): GlobalWorldSettings {
  const safeValue = isRecord(value) ? value : {};
  return {
    weather: isWeather(safeValue.weather) ? safeValue.weather : "Солнце",
    timeOfDay: isTimeOfDay(safeValue.timeOfDay) ? safeValue.timeOfDay : "Утро",
    eventName: toSafeString(safeValue.eventName, "").slice(0, 100)
  };
}
function sanitizeSystemStatusSettings(value: unknown): SystemStatusSettings {
  const safeValue = isRecord(value) ? value : {};
  const rawTargetSegments = Array.isArray(safeValue.targetSegments)
    ? safeValue.targetSegments
    : [];

  const targetSegments = Array.from(
    new Set(
      rawTargetSegments
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 40))
        .filter(Boolean)
    )
  ).slice(0, 20);

  return {
    maintenanceEnabled: safeValue.maintenanceEnabled === true,
    title: toSafeString(safeValue.title, "Технические работы").slice(0, 100) || "Технические работы",
    message:
      toSafeString(
        safeValue.message,
        "Сейчас в игре идут технические работы. Попробуй зайти немного позже."
      ).slice(0, 600) ||
      "Сейчас в игре идут технические работы. Попробуй зайти немного позже.",
    targetSegments
  };
}
function sanitizeSystemAnnouncementSettings(value: unknown): SystemAnnouncementSettings {
  const safeValue = isRecord(value) ? value : {};
  const rawTargetSegments = Array.isArray(safeValue.targetSegments)
    ? safeValue.targetSegments
    : [];

  const targetSegments = Array.from(
    new Set(
      rawTargetSegments
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 40))
        .filter(Boolean)
    )
  ).slice(0, 20);

  return {
    enabled: safeValue.enabled === true,
    title: toSafeString(safeValue.title, "Объявление").slice(0, 100) || "Объявление",
    message:
      toSafeString(
        safeValue.message,
        ""
      ).slice(0, 800),
    targetSegments
  };
}

function sanitizePlayerSegment(value: unknown) {
  return toSafeString(value, "").trim().slice(0, 40);
}

function getSegmentLabel(value: string) {
  return value || "Без сегмента";
}

function getPlayerSegmentFromProgress(progress: unknown) {
  return sanitizeProgress(progress).admin.segment;
}

function isMaintenanceActiveForSegment(
  systemStatus: SystemStatusSettings,
  playerSegment: string
) {
  if (!systemStatus.maintenanceEnabled) {
    return false;
  }

  if (systemStatus.targetSegments.length === 0) {
    return true;
  }

  return systemStatus.targetSegments.includes(playerSegment);
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
  const adminRaw = isRecord(root.admin) ? root.admin : {};
  const inventoryRaw = Array.isArray(root.inventory) ? root.inventory : [];
  const tasksRaw = Array.isArray(root.tasks) ? root.tasks : [];
  const locationsRaw = Array.isArray(root.locations) ? root.locations : [];
  const inventory = inventoryRaw
    .slice(0, 200)
    .map(sanitizeInventoryItem)
    .filter((item) => item.id && item.name);
  const tasks = tasksRaw
    .slice(0, 100)
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
    : [])
    .filter((value): value is string => typeof value === "string")
    .slice(0, 3);
  const unlockedComics = (Array.isArray(storyRaw.unlockedComics)
    ? storyRaw.unlockedComics
    : [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 100);
  return {
    player: {
      name: toSafeString(playerRaw.name, DEFAULT_PLAYER_NAME),
      coins: toSafeNumber(playerRaw.coins, DEFAULT_PLAYER_COINS, 0, 999999)
    },
    world: {
      weather: isWeather(worldRaw.weather) ? worldRaw.weather : "Солнце",
      timeOfDay: isTimeOfDay(worldRaw.timeOfDay) ? worldRaw.timeOfDay : "Утро",
      eventName: toSafeString(worldRaw.eventName, "").slice(0, 100)
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
    },
    admin: {
      banned: toSafeBoolean(adminRaw.banned),
      segment: sanitizePlayerSegment(adminRaw.segment)
    }
  };
}
function buildEffectiveProgress(progress: unknown, globalWorld: GlobalWorldSettings) {
  const safe = sanitizeProgress(progress);
  return {
    ...safe,
    world: {
      ...safe.world,
      weather: globalWorld.weather,
      timeOfDay: globalWorld.timeOfDay,
      eventName: globalWorld.eventName
    }
  };
}
function countVisitedFlags(visited: {
  keepers: boolean;
  alchemy: boolean;
  workshop: boolean;
  fishing: boolean;
  paths: boolean;
}) {
  return [
    visited.keepers,
    visited.alchemy,
    visited.workshop,
    visited.fishing,
    visited.paths
  ].filter(Boolean).length;
}
function getLevelFromSummary(summary: {
  tasksDone: number;
  tasksClaimed: number;
  catches: number;
  perfectCatches: number;
  aromasCount: number;
  inventoryItems: number;
}) {
  const storyUnits =
    summary.tasksClaimed * 4 + Math.max(0, summary.tasksDone - summary.tasksClaimed);
  const activityUnits = Math.min(
    5,
    Math.floor(
      (summary.catches +
        summary.perfectCatches +
        summary.aromasCount +
        summary.inventoryItems) /
        8
    )
  );
  return clampInteger(1 + Math.floor((storyUnits + activityUnits) / 5), 1, 20);
}
function getActLabelByLevel(level: number) {
  if (level <= 5) {
    return "I акт";
  }
  if (level <= 10) {
    return "II акт";
  }
  if (level <= 15) {
    return "III акт";
  }
  return "IV акт";
}
function buildProgressSummary(progress: unknown) {
  const safe = sanitizeProgress(progress);
  const baseSummary = {
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
    lastCatchName: safe.fishing.lastCatchName,
    banned: safe.admin.banned,
    segment: safe.admin.segment
  };
  const level = getLevelFromSummary(baseSummary);
  const progressPercent = baseSummary.tasksTotal
    ? clampInteger(
        Math.round((baseSummary.tasksDone / baseSummary.tasksTotal) * 100),
        0,
        100
      )
    : 0;
  return {
    ...baseSummary,
    progressPercent,
    level,
    actLabel: getActLabelByLevel(level)
  };
}
function looksLikeFreshStartProgress(progress: unknown) {
  const safe = sanitizeProgress(progress);
  const summary = buildProgressSummary(safe);
  const visitedCount = countVisitedFlags(safe.village.visited);
  return (
    safe.player.name === DEFAULT_PLAYER_NAME &&
    safe.player.coins <= DEFAULT_PLAYER_COINS &&
    visitedCount <= 1 &&
    !safe.village.caughtFirstFish &&
    !safe.village.brewedFirstAroma &&
    !safe.story.firstTrailsGatherDone &&
    safe.story.unlockedComics.length <= 1 &&
    summary.tasksClaimed === 0 &&
    summary.catches === 0 &&
    summary.perfectCatches === 0 &&
    summary.aromasCount === 0 &&
    safe.inventory.length <= 4
  );
}
function hasMeaningfulProgress(progress: unknown) {
  const safe = sanitizeProgress(progress);
  const summary = buildProgressSummary(safe);
  const visitedCount = countVisitedFlags(safe.village.visited);
  return (
    summary.tasksClaimed > 0 ||
    summary.tasksDone > 1 ||
    summary.catches > 0 ||
    summary.perfectCatches > 0 ||
    summary.aromasCount > 0 ||
    safe.story.firstTrailsGatherDone ||
    safe.village.caughtFirstFish ||
    safe.village.brewedFirstAroma ||
    visitedCount >= 3 ||
    safe.story.unlockedComics.length > 1 ||
    summary.coins > DEFAULT_PLAYER_COINS ||
    safe.inventory.length > 4
  );
}
function shouldRejectSuspiciousProgressSave(existingProgress: unknown, incomingProgress: unknown) {
  const existingSafe = sanitizeProgress(existingProgress);
  const incomingSafe = sanitizeProgress(incomingProgress);
  const existingSummary = buildProgressSummary(existingSafe);
  const incomingSummary = buildProgressSummary(incomingSafe);
  const existingVisitedCount = countVisitedFlags(existingSafe.village.visited);
  const incomingVisitedCount = countVisitedFlags(incomingSafe.village.visited);
  const incomingLooksLikeFreshStart = looksLikeFreshStartProgress(incomingSafe);
  const existingHasRealProgress = hasMeaningfulProgress(existingSafe);
  const largeRollbackDetected =
    incomingSummary.tasksClaimed < existingSummary.tasksClaimed ||
    incomingSummary.tasksDone + 1 < existingSummary.tasksDone ||
    incomingSummary.catches < existingSummary.catches ||
    incomingSummary.perfectCatches < existingSummary.perfectCatches ||
    incomingSummary.aromasCount < existingSummary.aromasCount ||
    incomingSafe.story.unlockedComics.length < existingSafe.story.unlockedComics.length ||
    incomingVisitedCount + 1 < existingVisitedCount ||
    (existingSummary.coins > DEFAULT_PLAYER_COINS && incomingSummary.coins <= DEFAULT_PLAYER_COINS) ||
    (existingSafe.inventory.length > 6 && incomingSafe.inventory.length <= 4);
  return incomingLooksLikeFreshStart && existingHasRealProgress && largeRollbackDetected;
}
function mergeTasksForPlayerSave(
  existingTasks: ReturnType<typeof sanitizeProgress>["tasks"],
  incomingTasks: ReturnType<typeof sanitizeProgress>["tasks"]
) {
  const byId = new Map<string, (typeof incomingTasks)[number]>();
  existingTasks.forEach((task) => {
    byId.set(task.id, { ...task });
  });
  incomingTasks.forEach((task) => {
    const previous = byId.get(task.id);
    if (!previous) {
      byId.set(task.id, { ...task });
      return;
    }
    byId.set(task.id, {
      ...previous,
      ...task,
      done: previous.done || task.done || task.claimed,
      claimed: previous.claimed || task.claimed
    });
  });
  return Array.from(byId.values());
}
function mergeLocationsForPlayerSave(
  existingLocations: ReturnType<typeof sanitizeProgress>["locations"],
  incomingLocations: ReturnType<typeof sanitizeProgress>["locations"]
) {
  const byId = new Map<string, (typeof incomingLocations)[number]>();
  existingLocations.forEach((location) => {
    byId.set(location.id, { ...location });
  });
  incomingLocations.forEach((location) => {
    const previous = byId.get(location.id);
    if (!previous) {
      byId.set(location.id, { ...location });
      return;
    }
    byId.set(location.id, {
      ...previous,
      ...location,
      status:
        previous.status === "Открыто" || location.status === "Открыто"
          ? "Открыто"
          : "Закрыто"
    });
  });
  return Array.from(byId.values());
}
function mergePlayerProgressForSave(
  existingProgress: unknown,
  incomingProgress: unknown,
  globalWorld: GlobalWorldSettings
) {
  const existingSafe = sanitizeProgress(existingProgress);
  const incomingSafe = sanitizeProgress(incomingProgress);
  if (shouldRejectSuspiciousProgressSave(existingSafe, incomingSafe)) {
    console.warn(
      `[SAFE_SAVE] Rejected suspicious reset for user progress. Existing coins=${existingSafe.player.coins}, incoming coins=${incomingSafe.player.coins}`
    );
    return buildEffectiveProgress(existingSafe, globalWorld);
  }
  const merged = sanitizeProgress({
    ...incomingSafe,
    village: {
      ...incomingSafe.village,
      visited: {
        keepers: existingSafe.village.visited.keepers || incomingSafe.village.visited.keepers,
        alchemy: existingSafe.village.visited.alchemy || incomingSafe.village.visited.alchemy,
        workshop: existingSafe.village.visited.workshop || incomingSafe.village.visited.workshop,
        fishing: existingSafe.village.visited.fishing || incomingSafe.village.visited.fishing,
        paths: existingSafe.village.visited.paths || incomingSafe.village.visited.paths
      },
      caughtFirstFish:
        existingSafe.village.caughtFirstFish || incomingSafe.village.caughtFirstFish,
      brewedFirstAroma:
        existingSafe.village.brewedFirstAroma || incomingSafe.village.brewedFirstAroma
    },
    story: {
      unlockedComics: Array.from(
        new Set([
          ...existingSafe.story.unlockedComics,
          ...incomingSafe.story.unlockedComics
        ])
      ).slice(0, 100),
      firstTrailsGatherDone:
        existingSafe.story.firstTrailsGatherDone || incomingSafe.story.firstTrailsGatherDone
    },
    tasks: mergeTasksForPlayerSave(existingSafe.tasks, incomingSafe.tasks),
    locations: mergeLocationsForPlayerSave(existingSafe.locations, incomingSafe.locations),
    admin: existingSafe.admin
  });
  merged.world.weather = globalWorld.weather;
  merged.world.timeOfDay = globalWorld.timeOfDay;
  merged.world.eventName = globalWorld.eventName;
  if (
    merged.player.name === DEFAULT_PLAYER_NAME &&
    existingSafe.player.name !== DEFAULT_PLAYER_NAME
  ) {
    merged.player.name = existingSafe.player.name;
  }
  return merged;
}

function applyInventoryChangeToProgress(
  progress: unknown,
  itemId: string,
  itemName: string,
  itemKind: unknown,
  mode: "set" | "add",
  parsedCount: number
) {
  const safeProgress = sanitizeProgress(progress ?? {});
  const inventoryIndex = safeProgress.inventory.findIndex((item) => item.id === itemId);

  if (inventoryIndex === -1) {
    if (!itemName) {
      throw new Error("Для нового предмета нужно указать название");
    }

    const nextItem = {
      id: itemId,
      name: itemName,
      kind: isInventoryKind(itemKind) ? itemKind : "misc",
      count: clampInteger(parsedCount, 0, 9999)
    };

    if (nextItem.count > 0) {
      safeProgress.inventory.push(nextItem);
    }
  } else {
    const currentItem = safeProgress.inventory[inventoryIndex];
    const nextCount =
      mode === "set"
        ? clampInteger(parsedCount, 0, 9999)
        : clampInteger(currentItem.count + parsedCount, 0, 9999);

    safeProgress.inventory[inventoryIndex] = {
      ...currentItem,
      name: itemName || currentItem.name,
      kind: isInventoryKind(itemKind) ? itemKind : currentItem.kind,
      count: nextCount
    };

    if (nextCount <= 0) {
      safeProgress.inventory.splice(inventoryIndex, 1);
    }
  }

  safeProgress.inventory = safeProgress.inventory
    .filter((item) => item.count > 0)
    .slice(0, 200);

  return safeProgress;
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
function isBannedProgress(progress: unknown) {
  return sanitizeProgress(progress).admin.banned;
}
async function getOrCreateSystemUser() {
  return prisma.user.upsert({
    where: {
      telegramId: SYSTEM_TELEGRAM_ID
    },
    update: {},
    create: {
      telegramId: SYSTEM_TELEGRAM_ID,
      username: "__system__",
      firstName: "__system__",
      lastName: null,
      languageCode: null,
      photoUrl: null,
      progress: {
        globalWorld: {
          weather: "Солнце",
          timeOfDay: "Утро",
          eventName: ""
        },
        systemStatus: {
          maintenanceEnabled: false,
          title: "Технические работы",
          message: "Сейчас в игре идут технические работы. Попробуй зайти немного позже.",
          targetSegments: []
        }
      }
    }
  });
}
async function getGlobalWorldSettings() {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  return sanitizeGlobalWorldSettings(root.globalWorld);
}
async function setGlobalWorldSettings(settings: GlobalWorldSettings) {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  const nextProgress = {
    ...root,
    globalWorld: settings
  };
  await prisma.user.update({
    where: {
      id: systemUser.id
    },
    data: {
      progress: toJsonValue(nextProgress)
    }
  });
  return settings;
}
async function getSystemStatusSettings() {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  return sanitizeSystemStatusSettings(root.systemStatus);
}
async function setSystemStatusSettings(settings: SystemStatusSettings) {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  const nextProgress = {
    ...root,
    systemStatus: settings
  };
  await prisma.user.update({
    where: {
      id: systemUser.id
    },
    data: {
      progress: toJsonValue(nextProgress)
    }
  });
  return settings;
}
async function getSystemAnnouncementSettings() {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  return sanitizeSystemAnnouncementSettings(root.systemAnnouncement);
}
async function setSystemAnnouncementSettings(settings: SystemAnnouncementSettings) {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  const nextProgress = {
    ...root,
    systemAnnouncement: settings
  };
  await prisma.user.update({
    where: {
      id: systemUser.id
    },
    data: {
      progress: toJsonValue(nextProgress)
    }
  });
  return settings;
}

function sanitizeAdminLogDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const next: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(value).slice(0, 20)) {
    if (typeof rawValue === "string") {
      next[key] = rawValue.slice(0, 200);
      continue;
    }

    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      next[key] = rawValue;
      continue;
    }

    if (typeof rawValue === "boolean") {
      next[key] = rawValue;
      continue;
    }

    if (Array.isArray(rawValue)) {
      next[key] = rawValue.slice(0, 20).map((item) => {
        if (typeof item === "string") {
          return item.slice(0, 120);
        }

        if (typeof item === "number" && Number.isFinite(item)) {
          return item;
        }

        if (typeof item === "boolean") {
          return item;
        }

        return JSON.stringify(item).slice(0, 120);
      });
    }
  }

  return next;
}

function sanitizeAdminLogEntry(value: unknown): AdminLogEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = toSafeString(value.id, "");
  const at = toSafeString(value.at, "");
  const action = toSafeString(value.action, "");
  const targetType = toSafeString(value.targetType, "");
  const targetId = toSafeString(value.targetId, "");
  const targetLabel = toSafeString(value.targetLabel, "");

  if (!id || !at || !action || !targetType || !targetId || !targetLabel) {
    return null;
  }

  return {
    id,
    at,
    action,
    targetType,
    targetId,
    targetLabel,
    details: sanitizeAdminLogDetails(value.details)
  };
}

function makeAdminLogEntry(
  action: string,
  targetType: string,
  targetId: string,
  targetLabel: string,
  details?: Record<string, unknown>
): AdminLogEntry {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    at: new Date().toISOString(),
    action,
    targetType,
    targetId,
    targetLabel,
    details: sanitizeAdminLogDetails(details ?? {})
  };
}

async function appendAdminLog(
  action: string,
  targetType: string,
  targetId: string,
  targetLabel: string,
  details?: Record<string, unknown>
) {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  const rawLogs = Array.isArray(root.adminLogs) ? root.adminLogs : [];
  const safeLogs = rawLogs
    .map(sanitizeAdminLogEntry)
    .filter((item): item is AdminLogEntry => item !== null)
    .slice(0, 199);

  const nextProgress = {
    ...root,
    adminLogs: [
      makeAdminLogEntry(action, targetType, targetId, targetLabel, details),
      ...safeLogs
    ]
  };

  await prisma.user.update({
    where: {
      id: systemUser.id
    },
    data: {
      progress: toJsonValue(nextProgress)
    }
  });
}

async function getAdminLogs(limit = 100) {
  const systemUser = await getOrCreateSystemUser();
  const root = isRecord(systemUser.progress) ? systemUser.progress : {};
  const rawLogs = Array.isArray(root.adminLogs) ? root.adminLogs : [];

  return rawLogs
    .map(sanitizeAdminLogEntry)
    .filter((item): item is AdminLogEntry => item !== null)
    .slice(0, clampInteger(limit, 1, 200));
}

function getVisibleUsers(users: DbUser[]) {
  return users.filter((user) => user.telegramId !== SYSTEM_TELEGRAM_ID);
}

type BulkAdminAction = "add_coins" | "set_coins" | "ban" | "unban";

function isBulkAdminAction(value: unknown): value is BulkAdminAction {
  return (
    value === "add_coins" ||
    value === "set_coins" ||
    value === "ban" ||
    value === "unban"
  );
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
    const systemStatus = await getSystemStatusSettings();
    const playerSegment = getPlayerSegmentFromProgress(dbUser.progress);

    if (isMaintenanceActiveForSegment(systemStatus, playerSegment)) {
      throw new MaintenanceError(systemStatus);
    }

    if (isBannedProgress(dbUser.progress)) {
      throw new BannedError();
    }

    (req as AuthenticatedRequest).dbUser = dbUser;
    next();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unauthorized request";
    const statusCode =
      error instanceof MaintenanceError ? 503 : error instanceof BannedError ? 403 : 401;

    res.status(statusCode).json({
      ok: false,
      error: message
    });
  }
}
async function findUserOr404(userId: string, res: Response) {
  const user = await prisma.user.findUnique({
    where: {
      id: userId
    }
  });
  if (!user || user.telegramId === SYSTEM_TELEGRAM_ID) {
    res.status(404).json({
      ok: false,
      error: "User not found"
    });
    return null;
  }
  return user;
}
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    message: "Backend is running"
  });
});
app.get("/api/system/status", async (_req, res, next) => {
  try {
    const system = await getSystemStatusSettings();
    const announcement = await getSystemAnnouncementSettings();
    res.json({
      ok: true,
      system: {
        ...system,
        announcement
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/system-status", requireAdminSecret, async (_req, res, next) => {
  try {
    const system = await getSystemStatusSettings();
    const announcement = await getSystemAnnouncementSettings();

    res.json({
      ok: true,
      system: {
        ...system,
        announcement
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/system-status", requireAdminSecret, async (req, res, next) => {
  try {
    const current = await getSystemStatusSettings();
    const nextSystem = sanitizeSystemStatusSettings({
      maintenanceEnabled: req.body?.maintenanceEnabled ?? current.maintenanceEnabled,
      title: req.body?.title ?? current.title,
      message: req.body?.message ?? current.message,
      targetSegments: req.body?.targetSegments ?? current.targetSegments
    });

    await setSystemStatusSettings(nextSystem);
    await appendAdminLog("maintenance_update", "system", "global", "Системный статус", {
      maintenanceEnabled: nextSystem.maintenanceEnabled,
      title: nextSystem.title,
      targetSegments: nextSystem.targetSegments,
      scope: nextSystem.targetSegments.length > 0 ? "segments" : "all"
    });

    const announcement = await getSystemAnnouncementSettings();

    res.json({
      ok: true,
      system: {
        ...nextSystem,
        announcement
      }
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/auth/telegram", async (req, res) => {
  try {
    const initData = getInitDataFromRequest(req);
    const dbUser = await findOrCreateTelegramUser(initData);
    const systemStatus = await getSystemStatusSettings();
    const playerSegment = getPlayerSegmentFromProgress(dbUser.progress);

    if (isMaintenanceActiveForSegment(systemStatus, playerSegment)) {
      return res.status(503).json({
        ok: false,
        error: systemStatus.title || "Технические работы"
      });
    }

    if (isBannedProgress(dbUser.progress)) {
      return res.status(403).json({
        ok: false,
        error: "Player is banned"
      });
    }
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
app.get("/api/progress", requireTelegramAuth, async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const globalWorld = await getGlobalWorldSettings();
    res.json({
      ok: true,
      progress: buildEffectiveProgress(authReq.dbUser?.progress ?? {}, globalWorld)
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/progress", requireTelegramAuth, async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const globalWorld = await getGlobalWorldSettings();
    const mergedProgress = mergePlayerProgressForSave(
      authReq.dbUser?.progress ?? {},
      req.body?.progress ?? {},
      globalWorld
    );
    const updatedUser = await prisma.user.update({
      where: {
        id: authReq.dbUser!.id
      },
      data: {
        progress: toJsonValue(mergedProgress)
      }
    });
    res.json({
      ok: true,
      progress: buildEffectiveProgress(updatedUser.progress ?? {}, globalWorld)
    });
  } catch (error) {
    next(error);
  }
});
app.get("/api/admin/world", requireAdminSecret, async (_req, res, next) => {
  try {
    const settings = await getGlobalWorldSettings();
    res.json({
      ok: true,
      world: settings
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/admin/world", requireAdminSecret, async (req, res, next) => {
  try {
    const current = await getGlobalWorldSettings();
    const nextSettings = sanitizeGlobalWorldSettings({
      weather: req.body?.weather ?? current.weather,
      timeOfDay: req.body?.timeOfDay ?? current.timeOfDay,
      eventName: req.body?.eventName ?? current.eventName
    });
    await setGlobalWorldSettings(nextSettings);
    await appendAdminLog("world_update", "world", "global", "Глобальный мир", {
      weather: nextSettings.weather,
      timeOfDay: nextSettings.timeOfDay,
      eventName: nextSettings.eventName
    });
    res.json({
      ok: true,
      world: nextSettings
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/admin/world/restore", requireAdminSecret, async (req, res, next) => {
  try {
    const incomingWorld = req.body?.world;
    if (!incomingWorld || !isRecord(incomingWorld)) {
      return res.status(400).json({
        ok: false,
        error: "World object is missing"
      });
    }
    const restoredWorld = sanitizeGlobalWorldSettings(incomingWorld);
    await setGlobalWorldSettings(restoredWorld);
    await appendAdminLog("world_restore", "world", "global", "Глобальный мир", {
      weather: restoredWorld.weather,
      timeOfDay: restoredWorld.timeOfDay,
      eventName: restoredWorld.eventName
    });
    res.json({
      ok: true,
      world: restoredWorld,
      adminAction: {
        type: "restore_world"
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/announcement", requireAdminSecret, async (_req, res, next) => {
  try {
    const announcement = await getSystemAnnouncementSettings();

    res.json({
      ok: true,
      announcement
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/announcement", requireAdminSecret, async (req, res, next) => {
  try {
    const current = await getSystemAnnouncementSettings();
    const nextAnnouncement = sanitizeSystemAnnouncementSettings({
      enabled: req.body?.enabled ?? current.enabled,
      title: req.body?.title ?? current.title,
      message: req.body?.message ?? current.message,
      targetSegments: req.body?.targetSegments ?? current.targetSegments
    });

    await setSystemAnnouncementSettings(nextAnnouncement);
    await appendAdminLog("announcement_update", "announcement", "global", "Глобальное объявление", {
      enabled: nextAnnouncement.enabled,
      title: nextAnnouncement.title,
      targetSegments: nextAnnouncement.targetSegments,
      scope: nextAnnouncement.targetSegments.length > 0 ? "segments" : "all"
    });

    res.json({
      ok: true,
      announcement: nextAnnouncement
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
    const visibleUsers = users.filter((user) => user.telegramId !== SYSTEM_TELEGRAM_ID);
    res.json({
      ok: true,
      total: visibleUsers.length,
      users: visibleUsers.map((user) => ({
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
    const user = await findUserOr404(userId, res);
    if (!user) {
      return;
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
      const user = await findUserOr404(userId, res);
      if (!user) {
        return;
      }
      const globalWorld = await getGlobalWorldSettings();
      res.json({
        ok: true,
        user: {
          id: user.id,
          telegramId: user.telegramId.toString(),
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          updatedAt: user.updatedAt,
          summary: buildProgressSummary(user.progress ?? {})
        },
        progress: buildEffectiveProgress(user.progress ?? {}, globalWorld)
      });
    } catch (error) {
      next(error);
    }
  }
);
app.get("/api/admin/logs", requireAdminSecret, async (req, res, next) => {
  try {
    const limit = clampInteger(parseAdminNumber(req.query.limit) ?? 100, 1, 200);
    const logs = await getAdminLogs(limit);

    res.json({
      ok: true,
      total: logs.length,
      logs
    });
  } catch (error) {
    next(error);
  }
});


app.get("/api/admin/segments", requireAdminSecret, async (_req, res, next) => {
  try {
    const users = getVisibleUsers(
      await prisma.user.findMany({
        orderBy: {
          updatedAt: "desc"
        }
      })
    );

    const counts = new Map<string, number>();

    for (const user of users) {
      const summary = buildProgressSummary(user.progress ?? {});
      const key = summary.segment || "";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const segments = Array.from(counts.entries())
      .map(([value, total]) => ({
        value,
        label: getSegmentLabel(value),
        total
      }))
      .sort((a, b) => {
        if (a.value === "" && b.value !== "") return -1;
        if (a.value !== "" && b.value === "") return 1;
        return a.label.localeCompare(b.label, "ru");
      });

    res.json({
      ok: true,
      totalUsers: users.length,
      segments
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/users/:id/segment", requireAdminSecret, async (req, res, next) => {
  try {
    const userId = getSingleParam(req.params.id);

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "User id is missing"
      });
    }

    const user = await findUserOr404(userId, res);

    if (!user) {
      return;
    }

    const segment = sanitizePlayerSegment(req.body?.segment);
    const safeProgress = sanitizeProgress(user.progress ?? {});
    const previousSegment = safeProgress.admin.segment;

    safeProgress.admin.segment = segment;

    const updatedUser = await prisma.user.update({
      where: {
        id: userId
      },
      data: {
        progress: toJsonValue(safeProgress)
      }
    });

    await appendAdminLog("segment_update", "player", updatedUser.id, updatedUser.firstName, {
      username: updatedUser.username ?? "",
      telegramId: updatedUser.telegramId.toString(),
      previousSegment,
      nextSegment: segment
    });

    res.json({
      ok: true,
      summary: buildProgressSummary(updatedUser.progress ?? {}),
      progress: sanitizeProgress(updatedUser.progress ?? {}),
      adminAction: {
        type: "segment",
        previousSegment,
        nextSegment: segment
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/segments/bulk", requireAdminSecret, async (req, res, next) => {
  try {
    const applyToAll = req.body?.applyToAll === true;
    const segment = sanitizePlayerSegment(req.body?.segment);
    const rawUserIds: unknown[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const userIds = rawUserIds
      .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value: string) => value.trim());

    const allUsers = getVisibleUsers(
      await prisma.user.findMany({
        orderBy: {
          updatedAt: "desc"
        }
      })
    );

    const targetUsers = applyToAll
      ? allUsers
      : allUsers.filter((user) => userIds.includes(user.id));

    if (targetUsers.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No target users selected"
      });
    }

    const updatedResults: Array<{
      id: string;
      telegramId: string;
      firstName: string;
      username: string | null;
      summary: ReturnType<typeof buildProgressSummary>;
    }> = [];

    for (const user of targetUsers) {
      const safeProgress = sanitizeProgress(user.progress ?? {});
      safeProgress.admin.segment = segment;

      const updatedUser = await prisma.user.update({
        where: {
          id: user.id
        },
        data: {
          progress: toJsonValue(safeProgress)
        }
      });

      updatedResults.push({
        id: updatedUser.id,
        telegramId: updatedUser.telegramId.toString(),
        firstName: updatedUser.firstName,
        username: updatedUser.username,
        summary: buildProgressSummary(updatedUser.progress ?? {})
      });
    }

    await appendAdminLog(
      "segment_bulk_update",
      "players",
      applyToAll ? "all" : "selected",
      applyToAll ? "Все игроки" : "Выбранные игроки",
      {
        segment,
        affected: updatedResults.length,
        userIds: updatedResults.map((user) => user.id)
      }
    );

    res.json({
      ok: true,
      segment,
      affected: updatedResults.length,
      users: updatedResults
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/backup", requireAdminSecret, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: {
        updatedAt: "desc"
      }
    });
    const globalWorld = await getGlobalWorldSettings();
    const visibleUsers = users.filter((user) => user.telegramId !== SYSTEM_TELEGRAM_ID);
    await appendAdminLog("backup_export", "backup", "all", "Экспорт backup", {
      users: visibleUsers.length
    });

    res.json({
      ok: true,
      exportedAt: new Date().toISOString(),
      total: visibleUsers.length,
      world: globalWorld,
      users: visibleUsers.map((user) => ({
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        languageCode: user.languageCode,
        photoUrl: user.photoUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        summary: buildProgressSummary(user.progress ?? {}),
        progress: sanitizeProgress(user.progress ?? {})
      }))
    });
  } catch (error) {
    next(error);
  }
});
app.post(
  "/api/admin/users/:id/restore",
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
      const user = await findUserOr404(userId, res);
      if (!user) {
        return;
      }
      const incomingProgress = req.body?.progress;
      if (!incomingProgress || !isRecord(incomingProgress)) {
        return res.status(400).json({
          ok: false,
          error: "Progress object is missing"
        });
      }
      const globalWorld = await getGlobalWorldSettings();
      const restoredProgress = sanitizeProgress(incomingProgress);
      restoredProgress.world.weather = globalWorld.weather;
      restoredProgress.world.timeOfDay = globalWorld.timeOfDay;
      restoredProgress.world.eventName = globalWorld.eventName;
      const updatedUser = await prisma.user.update({
        where: {
          id: userId
        },
        data: {
          progress: toJsonValue(restoredProgress)
        }
      });
      await appendAdminLog("player_restore", "player", updatedUser.id, updatedUser.firstName, {
        username: updatedUser.username ?? "",
        telegramId: updatedUser.telegramId.toString()
      });
      res.json({
        ok: true,
        summary: buildProgressSummary(updatedUser.progress ?? {}),
        progress: sanitizeProgress(updatedUser.progress ?? {}),
        adminAction: {
          type: "restore",
          userId
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/users/bulk",
  requireAdminSecret,
  async (req, res, next) => {
    try {
      const action = req.body?.action;
      const applyToAll = req.body?.applyToAll === true;
      const rawUserIds: unknown[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
      const userIds = rawUserIds
        .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value: string) => value.trim());
      const amount = parseAdminNumber(req.body?.amount);

      if (!isBulkAdminAction(action)) {
        return res.status(400).json({
          ok: false,
          error: "Unknown bulk action"
        });
      }

      if ((action === "add_coins" || action === "set_coins") && amount === null) {
        return res.status(400).json({
          ok: false,
          error: "Amount must be a number"
        });
      }

      const allUsers = getVisibleUsers(
        await prisma.user.findMany({
          orderBy: {
            updatedAt: "desc"
          }
        })
      );

      const targetUsers = applyToAll
        ? allUsers
        : allUsers.filter((user) => userIds.includes(user.id));

      if (targetUsers.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "No target users selected"
        });
      }

      const updatedResults: Array<{
        id: string;
        telegramId: string;
        firstName: string;
        username: string | null;
        summary: ReturnType<typeof buildProgressSummary>;
      }> = [];

      for (const user of targetUsers) {
        const safeProgress = sanitizeProgress(user.progress ?? {});

        if (action === "add_coins") {
          safeProgress.player.coins = clampInteger(
            safeProgress.player.coins + (amount ?? 0),
            0,
            999999
          );
        } else if (action === "set_coins") {
          safeProgress.player.coins = clampInteger(amount ?? 0, 0, 999999);
        } else if (action === "ban") {
          safeProgress.admin.banned = true;
        } else if (action === "unban") {
          safeProgress.admin.banned = false;
        }

        const updatedUser = await prisma.user.update({
          where: {
            id: user.id
          },
          data: {
            progress: toJsonValue(safeProgress)
          }
        });

        updatedResults.push({
          id: updatedUser.id,
          telegramId: updatedUser.telegramId.toString(),
          firstName: updatedUser.firstName,
          username: updatedUser.username,
          summary: buildProgressSummary(updatedUser.progress ?? {})
        });
      }

      await appendAdminLog("bulk_action", "players", applyToAll ? "all" : "selected", applyToAll ? "Все игроки" : "Выбранные игроки", {
        action,
        amount: amount ?? null,
        affected: updatedResults.length,
        userIds: updatedResults.map((user) => user.id)
      });

      res.json({
        ok: true,
        action,
        amount: amount ?? null,
        affected: updatedResults.length,
        users: updatedResults
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/users/:id/coins",
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
      const mode = req.body?.mode === "set" ? "set" : "add";
      const parsedAmount = parseAdminNumber(req.body?.amount);
      if (parsedAmount === null) {
        return res.status(400).json({
          ok: false,
          error: "Amount must be a number"
        });
      }
      const user = await findUserOr404(userId, res);
      if (!user) {
        return;
      }
      const safeProgress = sanitizeProgress(user.progress ?? {});
      const previousCoins = safeProgress.player.coins;
      const nextCoins =
        mode === "set"
          ? clampInteger(parsedAmount, 0, 999999)
          : clampInteger(previousCoins + parsedAmount, 0, 999999);
      safeProgress.player.coins = nextCoins;
      const updatedUser = await prisma.user.update({
        where: {
          id: userId
        },
        data: {
          progress: toJsonValue(safeProgress)
        }
      });
      await appendAdminLog("coins_update", "player", updatedUser.id, updatedUser.firstName, {
        username: updatedUser.username ?? "",
        telegramId: updatedUser.telegramId.toString(),
        mode,
        amount: parsedAmount,
        previousCoins,
        nextCoins
      });
      res.json({
        ok: true,
        summary: buildProgressSummary(updatedUser.progress ?? {}),
        progress: sanitizeProgress(updatedUser.progress ?? {}),
        adminAction: {
          type: "coins",
          mode,
          amount: parsedAmount,
          previousCoins,
          nextCoins
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
app.post(
  "/api/admin/users/:id/tasks",
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
      const taskId = toSafeString(req.body?.taskId, "").trim();
      const action = toSafeString(req.body?.action, "").trim();
      if (!taskId) {
        return res.status(400).json({
          ok: false,
          error: "Task id is missing"
        });
      }
      if (
        action !== "set_done" &&
        action !== "unset_done" &&
        action !== "set_claimed" &&
        action !== "unset_claimed"
      ) {
        return res.status(400).json({
          ok: false,
          error: "Unknown task action"
        });
      }
      const user = await findUserOr404(userId, res);
      if (!user) {
        return;
      }
      const safeProgress = sanitizeProgress(user.progress ?? {});
      const taskIndex = safeProgress.tasks.findIndex((task) => task.id === taskId);
      if (taskIndex === -1) {
        return res.status(404).json({
          ok: false,
          error: "Task not found"
        });
      }
      const nextTask = {
        ...safeProgress.tasks[taskIndex]
      };
      if (action === "set_done") {
        nextTask.done = true;
      } else if (action === "unset_done") {
        nextTask.done = false;
        nextTask.claimed = false;
      } else if (action === "set_claimed") {
        nextTask.done = true;
        nextTask.claimed = true;
      } else if (action === "unset_claimed") {
        nextTask.claimed = false;
      }
      safeProgress.tasks[taskIndex] = nextTask;
      const updatedUser = await prisma.user.update({
        where: {
          id: userId
        },
        data: {
          progress: toJsonValue(safeProgress)
        }
      });
      await appendAdminLog("task_update", "player", updatedUser.id, updatedUser.firstName, {
        username: updatedUser.username ?? "",
        telegramId: updatedUser.telegramId.toString(),
        taskId,
        action
      });
      res.json({
        ok: true,
        summary: buildProgressSummary(updatedUser.progress ?? {}),
        progress: sanitizeProgress(updatedUser.progress ?? {}),
        adminAction: {
          type: "task",
          taskId,
          action
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
app.post(
  "/api/admin/users/:id/inventory",
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
      const itemId = toSafeString(req.body?.itemId, "").trim();
      const itemName = toSafeString(req.body?.itemName, "").trim();
      const itemKind = req.body?.itemKind;
      const mode = req.body?.mode === "set" ? "set" : "add";
      const parsedCount = parseAdminNumber(req.body?.count);
      if (!itemId) {
        return res.status(400).json({
          ok: false,
          error: "Item id is missing"
        });
      }
      if (parsedCount === null || parsedCount < 0) {
        return res.status(400).json({
          ok: false,
          error: "Count must be a non-negative number"
        });
      }
      if (itemName && !isInventoryKind(itemKind)) {
        return res.status(400).json({
          ok: false,
          error: "Item kind is invalid"
        });
      }
      const user = await findUserOr404(userId, res);
      if (!user) {
        return;
      }
      const safeProgress = sanitizeProgress(user.progress ?? {});
      const inventoryIndex = safeProgress.inventory.findIndex((item) => item.id === itemId);
      if (inventoryIndex === -1 && !itemName) {
        return res.status(400).json({
          ok: false,
          error: "Для нового предмета нужно указать название"
        });
      }
      if (inventoryIndex === -1) {
        const nextItem = {
          id: itemId,
          name: itemName,
          kind: isInventoryKind(itemKind) ? itemKind : "misc",
          count: clampInteger(parsedCount, 0, 9999)
        };
        if (nextItem.count > 0) {
          safeProgress.inventory.push(nextItem);
        }
      } else {
        const currentItem = safeProgress.inventory[inventoryIndex];
        const nextCount =
          mode === "set"
            ? clampInteger(parsedCount, 0, 9999)
            : clampInteger(currentItem.count + parsedCount, 0, 9999);
        safeProgress.inventory[inventoryIndex] = {
          ...currentItem,
          name: itemName || currentItem.name,
          kind: isInventoryKind(itemKind) ? itemKind : currentItem.kind,
          count: nextCount
        };
        if (nextCount <= 0) {
          safeProgress.inventory.splice(inventoryIndex, 1);
        }
      }
      safeProgress.inventory = safeProgress.inventory
        .filter((item) => item.count > 0)
        .slice(0, 200);
      const updatedUser = await prisma.user.update({
        where: {
          id: userId
        },
        data: {
          progress: toJsonValue(safeProgress)
        }
      });
      await appendAdminLog("inventory_update", "player", updatedUser.id, updatedUser.firstName, {
        username: updatedUser.username ?? "",
        telegramId: updatedUser.telegramId.toString(),
        itemId,
        itemName: itemName || "",
        itemKind: isInventoryKind(itemKind) ? itemKind : "misc",
        mode,
        count: parsedCount
      });
      res.json({
        ok: true,
        summary: buildProgressSummary(updatedUser.progress ?? {}),
        progress: sanitizeProgress(updatedUser.progress ?? {}),
        adminAction: {
          type: "inventory",
          itemId,
          mode,
          count: parsedCount
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
app.post(
  "/api/admin/users/:id/ban",
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
      const action = toSafeString(req.body?.action, "").trim();
      if (action !== "ban" && action !== "unban") {
        return res.status(400).json({
          ok: false,
          error: "Unknown ban action"
        });
      }
      const user = await findUserOr404(userId, res);
      if (!user) {
        return;
      }
      const safeProgress = sanitizeProgress(user.progress ?? {});
      safeProgress.admin.banned = action === "ban";
      const updatedUser = await prisma.user.update({
        where: {
          id: userId
        },
        data: {
          progress: toJsonValue(safeProgress)
        }
      });
      await appendAdminLog("ban_update", "player", updatedUser.id, updatedUser.firstName, {
        username: updatedUser.username ?? "",
        telegramId: updatedUser.telegramId.toString(),
        action
      });
      res.json({
        ok: true,
        summary: buildProgressSummary(updatedUser.progress ?? {}),
        progress: sanitizeProgress(updatedUser.progress ?? {}),
        adminAction: {
          type: "ban",
          action
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/bulk/inventory",
  requireAdminSecret,
  async (req, res, next) => {
    try {
      const scope = req.body?.scope === "all" ? "all" : "selected";
      const rawUserIds: unknown[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
      const userIds = rawUserIds
        .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value: string) => value.trim());

      const itemId = toSafeString(req.body?.itemId, "").trim();
      const itemName = toSafeString(req.body?.itemName, "").trim();
      const itemKind = req.body?.itemKind;
      const mode = req.body?.mode === "set" ? "set" : "add";
      const parsedCount = parseAdminNumber(req.body?.count);

      if (!itemId) {
        return res.status(400).json({
          ok: false,
          error: "Item id is missing"
        });
      }

      if (parsedCount === null || parsedCount < 0) {
        return res.status(400).json({
          ok: false,
          error: "Count must be a non-negative number"
        });
      }

      if (itemName && !isInventoryKind(itemKind)) {
        return res.status(400).json({
          ok: false,
          error: "Item kind is invalid"
        });
      }

      if (scope === "selected" && userIds.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "No users selected"
        });
      }

      const users = await prisma.user.findMany({
        where:
          scope === "all"
            ? {
                telegramId: {
                  not: SYSTEM_TELEGRAM_ID
                }
              }
            : {
                id: {
                  in: userIds
                },
                telegramId: {
                  not: SYSTEM_TELEGRAM_ID
                }
              }
      });

      if (users.length === 0) {
        return res.status(404).json({
          ok: false,
          error: "Users not found"
        });
      }

      const updatedUsers = await Promise.all(
        users.map(async (user) => {
          const nextProgress = applyInventoryChangeToProgress(
            user.progress ?? {},
            itemId,
            itemName,
            itemKind,
            mode,
            parsedCount
          );

          return prisma.user.update({
            where: {
              id: user.id
            },
            data: {
              progress: toJsonValue(nextProgress)
            }
          });
        })
      );

      await appendAdminLog("bulk_inventory", "players", scope === "all" ? "all" : "selected", scope === "all" ? "Все игроки" : "Выбранные игроки", {
        affected: updatedUsers.length,
        itemId,
        itemName,
        itemKind: isInventoryKind(itemKind) ? itemKind : "misc",
        mode,
        count: parsedCount,
        userIds: updatedUsers.map((user) => user.id)
      });

      res.json({
        ok: true,
        affected: updatedUsers.length,
        users: updatedUsers.map((user) => ({
          id: user.id,
          telegramId: user.telegramId.toString(),
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          summary: buildProgressSummary(user.progress ?? {})
        })),
        adminAction: {
          type: "bulk_inventory",
          scope,
          itemId,
          itemName,
          itemKind: isInventoryKind(itemKind) ? itemKind : "misc",
          mode,
          count: parsedCount
        }
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
