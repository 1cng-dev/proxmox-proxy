const path = require("node:path");

const SUPABASE_PATH = path.resolve(__dirname, "../../src/supabaseClient.js");
const RESOLVE_NODE_PATH = path.resolve(__dirname, "../../src/utils/resolveNode.js");
const NODE_FAILOVER_PATH = path.resolve(__dirname, "../../src/utils/nodeFailover.js");

// nodeFailover.js pulls in the real supabaseClient (which requires env vars
// and talks to a live project) and resolveNode.js (which calls live
// Proxmox). There's no mocking framework in this project (no jest/sinon) —
// this substitutes both via require.cache injection, the same technique
// proven out manually while building nodeFailover.js, then forces a fresh
// require of the module under test so it picks up the substitutes.
//
// `updateCalls` collects every vm_ownership update the code under test
// issues, so a test can assert on the self-heal write without a real DB.
function loadNodeFailover({ resolveNodeForVmid, supabaseUpdateShouldError = false } = {}) {
  const updateCalls = [];

  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: {
      from: (table) => ({
        update: (fields) => ({
          eq: (col, val) => {
            updateCalls.push({ table, fields, col, val });
            return Promise.resolve({
              error: supabaseUpdateShouldError ? new Error("mock update failure") : null,
            });
          },
        }),
      }),
    },
  };

  require.cache[RESOLVE_NODE_PATH] = {
    id: RESOLVE_NODE_PATH,
    filename: RESOLVE_NODE_PATH,
    loaded: true,
    exports: {
      resolveNodeForVmid: resolveNodeForVmid || (async () => null),
    },
  };

  delete require.cache[NODE_FAILOVER_PATH];
  const nodeFailover = require(NODE_FAILOVER_PATH);

  return { ...nodeFailover, updateCalls };
}

module.exports = { loadNodeFailover };
