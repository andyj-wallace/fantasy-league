ALTER TABLE "pending_confirmation_passes" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_confirmation_passes" ADD COLUMN "last_attempted_at" timestamp;--> statement-breakpoint
ALTER TABLE "pending_confirmation_passes" ADD COLUMN "last_error" text;