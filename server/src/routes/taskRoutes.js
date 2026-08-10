import express from "express";

import {
    addTask,
    getTasks,
    getTask
} from "../controllers/taskController.js";

import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/", protect, addTask);

router.get("/", protect, getTasks);

router.get("/:id", protect, getTask);

export default router;