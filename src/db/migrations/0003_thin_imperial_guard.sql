CREATE TABLE "pending_confirmation_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"external_fixture_id" text NOT NULL,
	"due_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_poll_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_discovery_ran_at" timestamp,
	"last_roster_import_ran_at" timestamp,
	"last_availability_sync_ran_at" timestamp,
	"next_live_poll_due_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "pending_confirmation_passes" ADD CONSTRAINT "pending_confirmation_passes_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_external_id_unique" UNIQUE("external_id");--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_external_id_unique" UNIQUE("external_id");