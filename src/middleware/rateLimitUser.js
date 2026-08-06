const rateLimit = require('express-rate-limit');

const rateLimitUser = rateLimit({
    windowMs : 60 * 1000, // 1 minute
    max: 30,
    keyGenerator: (req) => req.user?.id || req.ip,
    handler: (req, res) => {
        res.status(429).json({
            ok: false,
            error: 'Too many requests, please try again later.'
        });
    }
})

module.exports = rateLimitUser;