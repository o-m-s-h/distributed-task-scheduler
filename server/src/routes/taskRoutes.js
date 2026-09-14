import express from "express";

import {
    addTask,
    getTasks,
    getTask,
    cancel
} from "../controllers/taskController.js";

import { protect } from "../middleware/authMiddleware.js";
import { taskRateLimit } from "../middleware/rateLimit.js";

const router = express.Router();

router.use(protect, taskRateLimit);

router.param("id", (req, res, next, id) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ message: "Task ID must be a UUID" });
    }
    next();
});

router.post("/", addTask);
router.get("/", getTasks);
router.get("/:id", getTask);
router.post("/:id/cancel", cancel);

export default router;
