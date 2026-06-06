# Discord adapter research package

Main document: [Discord adapter implementation summary](./discord-adapter-implementation-summary.md)

This directory collects the implementation-oriented research for a future Discord `CommAdapter` in `agents-comm-bus`.

## Navigation

- [discord-adapter-implementation-summary.md](./discord-adapter-implementation-summary.md) — primary synthesis and actionable implementation recommendation.
- [bus-contract-touchpoints.md](./bus-contract-touchpoints.md) — repository analysis of how Discord should plug into the existing bus, daemon, factories, adapter contract, and Telegram reference patterns.
- [structured/discord-adapter-reference.md](./structured/discord-adapter-reference.md) — structured Discord API/platform reference from official docs.
- [discordjs_comparison.md](./discordjs_comparison.md) — human-readable Discord library evaluation.
- [comparison_matrix.json](./comparison_matrix.json) — machine-readable library comparison matrix.
- [raw-notes/INDEX.md](./raw-notes/INDEX.md) — cached raw Discord official documentation files used by the platform research.

## Bottom line

Implement Discord as a dynamically loaded `discord` comm adapter that uses Gateway for inbound, REST for outbound, eager blob storage for attachments, and the existing bus for routing, dedupe, audit, query resolution, and agent wake. Start with modular Discord.js packages (`@discordjs/ws`, `@discordjs/rest`, `@discordjs/core`, and possibly `@discordjs/builders`) and defer Discord components/buttons until the plain message path is proven.
