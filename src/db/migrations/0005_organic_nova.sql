ALTER TABLE "provider_poll_state" ADD COLUMN "current_season_year" integer;--> statement-breakpoint
ALTER TABLE "provider_poll_state" ADD COLUMN "coverage_fixture_player_stats" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_poll_state" ADD COLUMN "coverage_injuries" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_poll_state" ADD COLUMN "last_season_sync_ran_at" timestamp;