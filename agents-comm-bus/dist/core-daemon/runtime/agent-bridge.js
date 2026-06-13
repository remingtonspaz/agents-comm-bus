/** Merge hook-supplied process owner with daemon-resolved identity (AGE-58). */
export function sessionLeaseOwnerWithDaemon(ownerFromParams, daemonOwner) {
    return {
        process_pid: ownerFromParams?.process_pid ?? null,
        process_label: ownerFromParams?.process_label,
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