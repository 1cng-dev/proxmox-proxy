const express = require("express");
const bcrypt = require("bcryptjs");
const supabase = require("../supabaseClient");

const router = express.Router();

// POST /api/users/register — Create a new user in profiles table
router.post("/register", async (req, res, next) => {
    try {
        const { name, username, email, password, role } = req.body;

        if (!name || !username || !email || !password) {
            return res.status(400).json({
                ok: false,
                error: "name, username, email, and password are required",
            });
        }

        const password_hash = await bcrypt.hash(password, 12);
        const now = new Date().toISOString();

        const { data, error } = await supabase
            .from("profiles")
            .insert([
                {
                    name,
                    username,
                    email,
                    password_hash,
                    role: role || "user",
                    created_at: now,
                    updated_at: now,
                },
            ])
            .select("id, name, username, email, role, created_at")
            .single();

        if (error) {
            if (error.code === "23505") {
                return res.status(409).json({
                    ok: false,
                    error: "username or email already exists",
                });
            }
            throw error;
        }

        res.status(201).json({ ok: true, user: data });
    } catch (err) {
        next(err);
    }
});

module.exports = router;