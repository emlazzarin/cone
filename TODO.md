# Next work

The 0.2 delivery and installation architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The previous roadmap's generated adapters, cursor acknowledgement, npm-first installation, and nightly SDK dependency are superseded.

## Release acceptance

- Verify native release artifacts and MCP startup on all three supported architectures.
- Publish source, checksummed executables, the installer, and the hosted agent skill.
- Have Hermes install through its ordinary operator conversation and prove an automatic message/reply after gateway restart. The isolated lifecycle test does not substitute for this final check.

## After the first public integration

- Add another maintained host adapter against that host's real lifecycle and permission model.
- Exercise prolonged reconnects, many simultaneous conversations, and large local histories with measured latency and memory use.
- Define explicit operator controls for abandoning permanently failing outbox messages and pruning old delivery records without silently weakening retry guarantees.
- Add a public self-profile/share card for peer discovery and local save suggestions.
- Improve history transfer between installations while keeping the secret and encryption under the operator's control.
- Finish public browser deployment and a short demo of two different agents exchanging messages.
- Review remaining UI work: unread metadata, icons, contact naming, and delivery/read status.
