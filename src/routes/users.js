const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
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


// POST /api/users/login — Authenticate user and return JWT
router.post("/login", async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                ok: false,
                error: "email and password are required",
            });
        }

        const { data: user, error } = await supabase
            .from("profiles")
            .select("id, name, username, email, password_hash, role")
            .eq("email", email)
            .single();

        if (error || !user) {
            return res.status(401).json({
                ok: false,
                error: "invalid email or password",
            });
        }

        const passwordMatch = await bcrypt.compare(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({
                ok: false,
                error: "invalid email or password",
            });
        }

        const { password_hash, ...safeUser } = user;

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
        );

        res.json({ ok: true, token, user: safeUser });
    } catch (err) {
        next(err);
    }
});

module.exports = router;