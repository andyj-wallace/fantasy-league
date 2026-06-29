CREATE TYPE "public"."player_availability_status" AS ENUM('AVAILABLE', 'OUT', 'QUESTIONABLE');--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "availability_status" "player_availability_status" DEFAULT 'AVAILABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "availability_reason" text;--> statement-breakpoint
ALTER TABLE "player_match_stats" DROP COLUMN "direct_free_kick_goals_scored";