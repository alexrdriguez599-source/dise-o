import bcrypt from "bcryptjs";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export async function seedAdmin() {
  const adminUsername = process.env.ADMIN_SEED_USERNAME;
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;

  if (!adminUsername || !adminPassword) {
    logger.warn("ADMIN_SEED_USERNAME or ADMIN_SEED_PASSWORD not set — skipping admin seed");
    return;
  }

  try {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, adminUsername))
      .limit(1);

    if (existing.length > 0) {
      logger.info("Admin user already exists, skipping seed");
      return;
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await db.insert(users).values({
      username: adminUsername,
      passwordHash,
      role: "admin",
      credits: 9999,
      status: "active",
    });

    logger.info("Admin user seeded successfully");
  } catch (err) {
    logger.error({ err }, "Error seeding admin user");
  }
}
