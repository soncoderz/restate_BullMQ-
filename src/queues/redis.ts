import { Redis } from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export function createRedisConnection() {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });

  connection.on("error", (error) => {
    console.error("Redis connection error", {
      message: error.message,
    });
  });

  return connection;
}
