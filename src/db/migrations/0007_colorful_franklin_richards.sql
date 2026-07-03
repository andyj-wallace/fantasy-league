ALTER TABLE "users" ADD COLUMN "cognito_sub" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_lower_idx" ON "users" USING btree (lower("handle"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_cognito_sub_unique" UNIQUE("cognito_sub");