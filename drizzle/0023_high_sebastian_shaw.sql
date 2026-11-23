CREATE TABLE "device_cursor" (
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"session_id" text NOT NULL,
	"up_time_created" bigint,
	"up_message_id" text,
	"down_time_created" bigint,
	"down_message_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_cursor_user_id_device_id_session_id_pk" PRIMARY KEY("user_id","device_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_message" (
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint,
	"data" text NOT NULL,
	"device_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_message_session_id_id_pk" PRIMARY KEY("session_id","id")
);
--> statement-breakpoint
CREATE TABLE "session_part" (
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"id" text NOT NULL,
	"message_id" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint,
	"data" text NOT NULL,
	"device_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_part_session_id_id_pk" PRIMARY KEY("session_id","id")
);
--> statement-breakpoint
CREATE TABLE "session_state" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"directory" text,
	"agent" text,
	"model" text,
	"revert" text,
	"parent_id" text,
	"provider" text,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "session_message_cursor_idx" ON "session_message" USING btree ("session_id","time_created","id");--> statement-breakpoint
CREATE INDEX "session_message_user_idx" ON "session_message" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "session_part_message_idx" ON "session_part" USING btree ("session_id","message_id");