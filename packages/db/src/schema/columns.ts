import { timestamp } from "drizzle-orm/pg-core";

// Column names come from the keys in snake_case (`casing: "snake_case"` in the client and drizzle.config.ts).

export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
