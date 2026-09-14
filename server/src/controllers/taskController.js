import crypto from "crypto";
import { parseTaskInput } from "./taskInput.js";

import {
    createTask,
    getTasksByUser,
    getTaskById,
    cancelTask
} from "../models/taskModel.js";


export const addTask = async (req, res) => {
    try {
        let input;
        try {
            input = parseTaskInput(req.body, req.get("Idempotency-Key"));
        } catch (error) {
            return res.status(400).json({ message: error.message });
        }

        const { task, replayed } = await createTask({
            ...input,
            id: crypto.randomUUID(),
            userId: req.userId
        });

        res.status(replayed ? 200 : 201).json({
            message: replayed ? "Existing task returned" : "Task scheduled successfully",
            replayed,
            task
        });

    } catch (error) {
        if (error.status) return res.status(error.status).json({ message: error.message });
        console.error("Create task error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
};


export const getTasks = async (req, res) => {
    try {
        const tasks = await getTasksByUser(req.userId);

        res.json({
            tasks
        });

    } catch (error) {
        console.error("Get tasks error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
};


export const getTask = async (req, res) => {
    try {
        const task = await getTaskById(
            req.params.id,
            req.userId
        );

        if (!task) {
            return res.status(404).json({
                message: "Task not found"
            });
        }

        res.json({
            task
        });

    } catch (error) {
        console.error("Get task error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
};

export const cancel = async (req, res) => {
    try {
        const scope = req.body?.scope ?? "TASK";
        if (!["TASK", "SERIES"].includes(scope)) {
            return res.status(400).json({ message: "scope must be TASK or SERIES" });
        }
        const result = await cancelTask(req.params.id, req.userId, scope);
        if (!result) return res.status(404).json({ message: "Task not found" });
        const pending = result.task.status === "RUNNING" && result.task.cancel_requested_at;
        return res.status(pending ? 202 : 200).json(result);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ message: error.message });
        console.error("Cancel task error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};
