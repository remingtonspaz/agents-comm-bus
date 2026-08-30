import { readProcessStartEpochMs } from "./process-start-epoch.js";
/** Merge hook-supplied process owner with daemon-resolved identity (AGE-58). */
export function sessionLeaseOwnerWithDaemon(ownerFromParams, daemonOwner) {
    const pid = ownerFromParams?.process_pid ?? null;
    let startTime = ownerFromParams?.process_start_time ?? null;
    if (pid != null && startTime == null) {
        startTime = readProcessStartEpochMs(pid);
    }
    return {
        process_pid: pid,
        process_label: ownerFromParams?.process_label,
        process_start_time: pid != null ? startTime : null,
        daemon: {
            discovery_root: daemonOwner.discoveryRoot,
            checkout_root: daemonOwner.checkoutRoot,
            state_root: daemonOwner.stateRoot,
            daemon_bin: daemonOwner.daemonBin,
            authority_rank: daemonOwner.authorityRank,
        },
    };
}
//# sourceMappingURL=agent-bridge.js.map