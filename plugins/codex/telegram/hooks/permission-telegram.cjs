#!/usr/bin/env node
/**
 * Compatibility wrapper for the Phase 2 Claude-named PermissionRequest hook.
 */

import('./claude/permission-request.js').catch((error) => {
    process.stderr.write(`Claude PermissionRequest compatibility wrapper failed: ${error.message}\n`);
    console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
});
