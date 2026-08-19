import { drizzle } from "drizzle-orm/d1";

export type Db = ReturnType<typeof createDb>;

export const createDb = (d1: D1Database) => drizzle(d1);
