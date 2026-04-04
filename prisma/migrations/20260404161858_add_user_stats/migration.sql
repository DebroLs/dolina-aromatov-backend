-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastProgressSaveAt" TIMESTAMP(3),
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "progressSaveCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "visitCount" INTEGER NOT NULL DEFAULT 0;
