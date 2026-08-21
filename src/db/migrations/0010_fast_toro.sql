CREATE TYPE "public"."goal_type" AS ENUM('NORMAL', 'PENALTY', 'OWN_GOAL');--> statement-breakpoint
CREATE TABLE "match_goal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"scorer_player_id" uuid,
	"assist_player_id" uuid,
	"beneficiary_club" text NOT NULL,
	"goal_type" "goal_type" NOT NULL,
	"elapsed_minute" integer NOT NULL,
	"added_time_minute" integer DEFAULT 0 NOT NULL,
	"sequence_index" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_match_stats" ADD COLUMN "was_in_starting_lineup" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "match_goal_events" ADD CONSTRAINT "match_goal_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_goal_events" ADD CONSTRAINT "match_goal_events_scorer_player_id_players_id_fk" FOREIGN KEY ("scorer_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_goal_events" ADD CONSTRAINT "match_goal_events_assist_player_id_players_id_fk" FOREIGN KEY ("assist_player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;