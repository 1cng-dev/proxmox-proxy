const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                ok: false,
                error: "forbidden: insufficient permissions",
            });
        }
        next();
    };
};

module.exports = authorize;
