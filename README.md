# Shario VS Code Extension (Work in Progress)

The VS Code client for [Shario](https://github.com/Muna-Louis-Nwugo/shario), a real-time collaborative text editor backend built on a CRDT. This extension is the IDE half: it forwards every keystroke to a running `shar` server and applies whatever the server confirms, so multiple editors attached to the same server stay in sync.

**Status: work in progress.** Connecting to a server, typing, and deleting in a tracked file all work and are covered by the [main repo's benchmark suite](https://github.com/Muna-Louis-Nwugo/shario/blob/main/info/BENCHMARK.md) against real editing-trace datasets. This extension is send-only in the sense that it doesn't yet render incoming edits from *other* collaborators on screen — see Known limitations below.

## How it works, in short

Every character you type or delete is sent to the server as an `ide-add`/`remove` event, referencing its neighbor by identity (or a disposable local tag, if that neighbor hasn't been confirmed by the server yet) rather than by position — so a fast burst of edits can never let this client's understanding of "where things are" drift from the server's. See the [main repo's architecture doc](https://github.com/Muna-Louis-Nwugo/shario/blob/main/info/ARCHITECTURE.md) for the full protocol and design.

If the server process dies, this extension notices and restarts it automatically (`maybeRestartServer` in `extension.js`) — provided it was the one that started the server in the first place.

## Setup

Requires the [`shario`](https://github.com/Muna-Louis-Nwugo/shario) server checked out as a sibling directory (`../shario` relative to this one) with a local Rust toolchain, since this extension launches it via `cargo run` when it needs to.

```bash
npm install        # installs socket.io-client
code .              # open this folder in VS Code
```

Then, inside that VS Code window:
1. Press `F5` to launch an Extension Development Host.
2. In the new window, open the folder you want to collaborate on.
3. Run **"Shar: Connect"** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
4. Type or delete in a file — check the **"Shar"** output channel (`View > Output`, select "Shar" from the dropdown) to see what's being sent.

If a `shar` server isn't already running for that workspace folder, this extension starts one for you.

## Known limitations

- Doesn't yet apply or render edits made by other collaborators — only sends this editor's own changes out.
- Deleting content that existed on disk *before* this client connected only resolves correctly once the server's `initial-state` bootstrap event is in place server-side.
- One extension instance per workspace folder; no UI yet for switching which folder/server you're connected to beyond reconnecting.

## License

GNU General Public License v3 — same as the main [`shario`](https://github.com/Muna-Louis-Nwugo/shario) repo. Free to use, forever.
