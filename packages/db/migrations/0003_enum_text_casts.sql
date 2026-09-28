-- The RDS Data API sends every string parameter as text, and Postgres will not assign text to an
-- enum column by itself, so inserts and updates fail in AWS. These casts let text be stored in an
-- enum column, as an untyped node-postgres parameter already is locally. Comparing an enum column
-- with a parameter still needs an explicit cast. Every new enum type needs the same cast (a db
-- test checks it).
CREATE CAST (text AS "public"."component_status") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."page_visibility") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."member_role") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."monitor_type") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."publish_policy") WITH INOUT AS IMPLICIT;--> statement-breakpoint
CREATE CAST (text AS "public"."down_status") WITH INOUT AS IMPLICIT;
