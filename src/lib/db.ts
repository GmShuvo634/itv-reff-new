import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Database connection configuration with retry mechanism
const createPrismaClient = () => {
  return new PrismaClient({
    log: ["query", "info", "warn", "error"],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
    errorFormat: "pretty",
  });
};

// Database connection with retry logic
async function connectWithRetry(
  client: PrismaClient,
  maxRetries = 5,
  delay = 1000,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await client.$connect();
      console.log("Database connected successfully");
      return;
    } catch (error) {
      console.error(`Database connection attempt ${i + 1} failed:`, error);

      if (i === maxRetries - 1) {
        throw new Error(
          `Failed to connect to database after ${maxRetries} attempts`,
        );
      }

      // Wait before retrying with exponential backoff
      const backoffDelay = delay * Math.pow(2, i);
      console.log(`Retrying database connection in ${backoffDelay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffDelay));
    }
  }
}

// Create database client with connection retry
export const db = globalForPrisma.prisma ?? createPrismaClient();

// Initialize connection with retry mechanism
if (!globalForPrisma.prisma) {
  connectWithRetry(db).catch((error) => {
    console.error("Fatal database connection error:", error);
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

// Graceful shutdown
process.on("SIGINT", async () => {
  await db.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await db.$disconnect();
  process.exit(0);
});

// Health check function
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error("Database health check failed:", error);
    return false;
  }
}

// Database transaction wrapper with retry
export async function withRetry<T>(
  operation: (prisma: PrismaClient) => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation(db);
    } catch (error: any) {
      console.error(`Database operation attempt ${i + 1} failed:`, error);

      // Don't retry on certain errors
      if (error.code === "P2002" || error.code === "P2025") {
        throw error;
      }

      if (i === maxRetries - 1) {
        throw error;
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }

  throw new Error("Unreachable code");
}
