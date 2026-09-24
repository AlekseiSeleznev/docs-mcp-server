# Hosted lib-docs extension for Claude Desktop

The 4.0.0 desktop extension connects to the hosted Plaut AI library at
`https://aichat.msgplaut.com/lib-docs/mcp`. It does not require a local
Grounded Docs database and does not contain a Bearer token. The extension
prompts for the user's token during installation. It exposes the tools
available on the hosted MCP server.

This is a **local desktop extension** for Claude Desktop, subject to the
organization's extension policy. It is not a web connector, and installing it
does not configure Claude on the web or mobile. Cowork access depends on the
desktop app being available and on the session and organization settings.

## Install

1. Download the `.mcpb` for your operating system and architecture:
   `linux-x64`, `windows-x64`, `macos-x64`, or `macos-arm64`.
2. Open Claude Desktop → Settings → Extensions → Advanced settings →
   Install Extension, then select the `.mcpb` file.
3. Enter the Bearer token supplied by the Plaut AI library administrator.
   Enter the token itself, without the `Bearer ` prefix.
4. Enable the extension and ask Claude to list the `lib-docs` libraries.
   Keep Claude Desktop open while using Cowork. If the extension is disabled
   by organization policy, ask the organization owner to allow it. Availability
   in a Cowork session also depends on its execution mode.

Version 3.0.0 used the local index. If it is already installed, update it to
4.0.0 or remove the old extension before installing the new one. Restart
Claude Desktop after an update if the old tools remain visible.

## Build and verify

GitHub Actions workflow `Hosted Library Desktop Extensions` builds and
smoke-tests each target on its native operating system. It validates the
manifest and confirms that an extracted extension forwards authenticated
`tools/list` and `tools/call` to a local test MCP server. The test uses only
the fake token `test-token`; no production credential enters CI.
