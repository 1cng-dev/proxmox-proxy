const cooldowns = new Map();

function vmActionCooldown(minIntervalMs = 5000){
    return (req, res, next) => {
        const key = `${req.params.node}:${req.params.vmid}`;
        const last = cooldowns.get(key);
        if(last && Date.now() - last < minIntervalMs){
            const err = new Error("VM action cooldown in effect");
            err.status = 429;
            return next(err);
        }

        cooldowns.set(key, Date.now());
        next();
    }
}

module.exports = vmActionCooldown;