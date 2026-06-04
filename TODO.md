# TODO

- Replace the temporary XMTP nightly Node dependencies with stable releases once XMTP publishes a fixed stable macOS arm64 `@xmtp/node-bindings` package. The stable `@xmtp/node-sdk@6.0.0` currently pulls `@xmtp/node-bindings@1.10.0`, whose published macOS arm64 binary is linked to a machine-specific Nix `libiconv` path. Cone currently requires `@xmtp/node-sdk >=6.1.0-nightly <6.2.0` so Bun does not resolve back to the broken stable SDK.
