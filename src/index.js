require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const nodesRouter = require("./routes/nodes");
const vmsRouter = require("./routes/vms");
const usersRouter = require("./routes/users");
const errorHandler = require("./errorHandler");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ──────────────────────────────
app.use(helmet());
app.use(express.json());
app.use(morgan("dev"));

// CORS — allow only from VMP origin
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : "*",
    methods: ["GET", "POST", "DELETE"],
  })
);

// Rate Limit — max 100 requests per minute
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { ok: false, error: "Too many requests" },
  })
);

// ─── Health Check ─────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "proxmox-proxy",
    proxmox: process.env.PROXMOX_URL,
    defaultNode: process.env.PROXMOX_DEFAULT_NODE,
    timestamp: new Date().toISOString(),
  });
});

// ─── Routes ───────────────────────────────────────────
//
// Node list
//   GET  /api/nodes
//   GET  /api/nodes/:node
//
// VM operations (default node)
//   GET    /api/vms                    → VM list (default node)
//   GET    /api/vms/:vmid              → VM status + config
//   POST   /api/vms/:vmid/start
//   POST   /api/vms/:vmid/stop
//   POST   /api/vms/:vmid/shutdown
//   POST   /api/vms/:vmid/reboot
//   DELETE /api/vms/:vmid              → Terminate (destroy)
//   GET    /api/vms/:vmid/stats        → CPU/RAM/Disk/Net stats
//   GET    /api/vms/:vmid/console      → noVNC ticket
//   GET    /api/vms/:vmid/task/:upid   → Task status
//
// VM operations (specific node)
//   GET    /api/nodes/:node/vms
//   GET    /api/nodes/:node/vms/:vmid
//   POST   /api/nodes/:node/vms/:vmid/start
//   ... (same pattern)

app.use("/api/users", usersRouter);
app.use("/api/nodes", nodesRouter);

// Default node route — uses PROXMOX_DEFAULT_NODE
app.use("/api/vms", (req, res, next) => {
  req.params.node = process.env.PROXMOX_DEFAULT_NODE || "node1";
  next();
}, vmsRouter);

// Specific node route
app.use("/api/nodes/:node/vms", vmsRouter);

// ─── Error Handler ────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nProxmox Proxy running on port ${PORT}`);
  console.log(`   Proxmox URL  : ${process.env.PROXMOX_URL}`);
  console.log(`   Default Node : ${process.env.PROXMOX_DEFAULT_NODE}`);
  console.log(`   Health check : http://localhost:${PORT}/health\n`);
  console.log("Available endpoints:");
  console.log("  GET  /api/nodes");
  console.log("  GET  /api/nodes/:node");
  console.log("  GET  /api/vms  (or /api/nodes/:node/vms)");
  console.log("  GET  /api/vms/:vmid");
  console.log("  POST /api/vms/:vmid/start");
  console.log("  POST /api/vms/:vmid/stop");
  console.log("  POST /api/vms/:vmid/shutdown");
  console.log("  POST /api/vms/:vmid/reboot");
  console.log("  DEL  /api/vms/:vmid");
  console.log("  GET  /api/vms/:vmid/stats?timeframe=hour");
  console.log("  GET  /api/vms/:vmid/console");
  console.log("  GET  /api/vms/:vmid/task/:upid");
  console.log("  POST /api/users/register\n");
});
{
  
}
