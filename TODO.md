# TODO

- [ ] replace the temporary XMTP nightly Node dependencies with stable releases once XMTP publishes a fixed stable macOS arm64 `@xmtp/node-bindings` package. The stable `@xmtp/node-sdk@6.0.0` currently pulls `@xmtp/node-bindings@1.10.0`, whose published macOS arm64 binary is linked to a machine-specific Nix `libiconv` path. Cone currently requires `@xmtp/node-sdk >=6.1.0-nightly <6.2.0` so Bun does not resolve back to the broken stable SDK.
- [ ] an agentic skill of how to install and use this easily for agents themselves to use
- [ ] group chat functionality
- [ ] add how this works/explainer + Github link
- [ ] new name (remember to update secret key format)
- [ ] feature to sync data between versions of app? Send encrypted data to yourself style transfer. The use of the history feature?
- Clever use of "consent"?
- [ ] Skill so you can make your own version of the app with the same secret key and data store
- [ ] Favicon
- [ ] Standardize data store across app versions and then allow for data store sync across app instances?
- Minify/make data store efficient?
- [ ] Should we make it possible to export your derived XMTP key (if that even makes sense)?
- [ ] What clever uses of XMTP-specific features can we use?
- [ ] Support disappearing messages
- [ ] Anti spam?
- [ ] Context box/aliases/names/usernames/namespace

Way Later

- [ ] make Github publishable/squash history
- [ ] hosting the site somewhere
- [ ] jokey version with (iMessage-style bubble)
