require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const nodesRouter = require("./routes/nodes");
const vmsRouter = require("./routes/vms");
const errorHandler = require("./errorHandler");
const { handleConsoleUpgrade } = require("./wsConsoleProxy");
const vmStatusSync = require("./jobs/syncVmStatus");

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
// All routes below require `Authorization: Bearer <supabase-jwt>`; VM routes
// additionally check vm_ownership and override :node with the DB record
// (see src/middleware/authenticate.js and authorizeVm.js).
//
// Node list
//   GET  /api/nodes
//   GET  /api/nodes/:node
//
// VM operations (default node)
//   GET    /api/vms                    → VM list (caller's owned VMs only)
//   GET    /api/vms/:vmid              → VM status + config
//   POST   /api/vms/:vmid/start
//   POST   /api/vms/:vmid/stop
//   POST   /api/vms/:vmid/shutdown
//   POST   /api/vms/:vmid/reboot
//   DELETE /api/vms/:vmid              → Terminate (destroy) — admin role only
//   GET    /api/vms/:vmid/stats        → CPU/RAM/Disk/Net stats
//   GET    /api/vms/:vmid/console      → VNC session token + ws path
//   GET    /api/vms/:vmid/task/:upid   → Task status
//
// VM operations (specific node in the URL — node param is only used for
// routing; the actual Proxmox call always uses the vm_ownership node)
//   GET    /api/nodes/:node/vms
//   GET    /api/nodes/:node/vms/:vmid
//   POST   /api/nodes/:node/vms/:vmid/start
//   ... (same pattern)
//
// Console websocket (no HTTP route — upgraded directly, see below)
//   WS     /ws/console/:sessionToken

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
// Built on the raw http server (not app.listen) so the VNC console websocket
// can hook the 'upgrade' event directly — express itself never sees it.
const server = http.createServer(app);

server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/ws/console/")) {
    handleConsoleUpgrade(request, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
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
  console.log("  DEL  /api/vms/:vmid  (admin role required)");
  console.log("  GET  /api/vms/:vmid/stats?timeframe=hour");
  console.log("  GET  /api/vms/:vmid/console");
  console.log("  GET  /api/vms/:vmid/task/:upid");
  console.log("  WS   /ws/console/:sessionToken\n");

  vmStatusSync.start();
});
