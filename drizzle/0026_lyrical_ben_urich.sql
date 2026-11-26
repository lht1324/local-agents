CREATE TABLE "session_part" (
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"type" text NOT NULL,
	"call_id" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint,
	"data" text NOT NULL,
	"device_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_part_session_id_message_id_ordinal_pk" PRIMARY KEY("session_id","message_id","ordinal")
);
--> statement-breakpoint
CREATE INDEX "session_part_message_idx" ON "session_part" USING btree ("session_id","message_id");