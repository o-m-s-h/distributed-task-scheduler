import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/authRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import { startScheduler } from "./scheduler/scheduler.js";
import { authRateLimit } from "./middleware/rateLimit.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import { fileURLToPath } from "node:url";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
    res.json({
        message: "Distributed Task Scheduler API is running"
    });
});

app.use("/api/auth", authRateLimit, authRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use(express.static(fileURLToPath(new URL("../../client/", import.meta.url))));

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startScheduler();
});
