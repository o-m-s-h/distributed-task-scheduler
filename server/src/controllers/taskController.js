import crypto from "crypto";

import {
    createTask,
    getTasksByUser,
    getTaskById
} from "../models/taskModel.js";


export const addTask = async (req, res) => {
    try {
        const {
            name,
            type,
            payload,
            priority,
            scheduledAt
        } = req.body;

        if (!name || !type || !scheduledAt) {
            return res.status(400).json({
                message: "Name, type and scheduledAt are required"
            });
        }

        const task = await createTask({
            id: crypto.randomUUID(),
            userId: req.userId,
            name,
            type,
            payload: payload || {},
            priority: priority || "MEDIUM",
            scheduledAt
        });

        res.status(201).json({
            message: "Task scheduled successfully",
            task
        });

    } catch (error) {
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