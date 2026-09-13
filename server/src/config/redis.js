import Redis from "ioredis";
import "dotenv/config";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    commandTimeout: 10000
});

redis.on("connect", () => {
    console.log("Connected to Redis");
});

redis.on("error", (error) => {
    console.error("Redis error:", error);
});

export default redis;
