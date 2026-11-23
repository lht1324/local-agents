CREATE TABLE "session_link" (
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"device_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_link_user_id_session_id_device_id_pk" PRIMARY KEY("user_id","session_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "session_share" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "session_link_device_idx" ON "session_link" USING btree ("user_id","device_id");