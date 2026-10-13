# Shario VS Code Extension (Work in Progress)

The VS Code client for [Shario](https://github.com/Muna-Louis-Nwugo/shario), a real-time collaborative text editor backend built on a CRDT. This extension is the IDE half: it forwards every keystroke to a running `shar` server and applies whatever the server confirms, so multiple editors attached to the same server stay in sync.

**Status: work in progress.** Connecting to a server, typing, and deleting in a tracked file all work and are covered by the [main repo's benchmark suite](https://github.com/Muna-Louis-Nwugo/shario/blob/main/info/BENCHMARK.md) against real editing-trace datasets. This extension is send-only in the sense that it doesn't yet render incoming edits from *other* collaborators on screen — see Known limitations below.

## How it works, in short

Every character you type or delete is sent to the server as an `ide-add`/`remove` event, referencing its neighbor by identity (or a disposable local tag, if that neighbor hasn't been confirmed by the server yet) rather than by position — so a fast burst of edits can never let this client's understanding of "where things are" drift from the server's. See the [main repo's architecture doc](https://github.com/Muna-Louis-Nwugo/shario/blob/main/info/ARCHITECTURE.md) for the full protocol and design.

If the server process dies, this extension notices and restarts it automatically (`maybeRestartServer` in `extension.js`) — provided it was the one that started the server in the first place.

## Setup

Just Node.js — this extension no longer needs a local Rust toolchain or a `shario` source checkout. It downloads the right prebuilt `shario` binary for your OS/architecture from [GitHub Releases](https://github.com/Muna-Louis-Nwugo/shario/releases) automatically the first time it needs one, and caches it for later.

```bash
npm install        # installs socket.io-client
code .              # open this folder in VS Code
```

Then, inside that VS Code window, press `F5` to launch an Extension Development Host, open the folder you want to collaborate on, and run one of the commands below from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

## Commands

- **Shar: Create Session** — starts a brand-new session (prompts for a name, or generates a random one if left blank) and connects to it. Share the name shown afterward with whoever you want to collaborate with.
- **Shar: Participate in Session** — joins an existing session by the exact name its creator used.
- **Shar: Connect (attach to an already-running server)** — attaches to a `shar` server that's already running on this machine, without launching anything. Doesn't need a session name; it reads whatever the server was already started with.
- **Shar: Update Server Binary** — checks GitHub for the newest *stable* shario release and downloads it, warning first if its major version differs from what this extension currently expects (a likely-breaking change). Enable the `shario.enableBeta` setting first if you want this to consider pre-release/beta builds too, not just stable ones.

Type or delete in a tracked file afterward — check the **"Shar"** output channel (`View > Output`, select "Shar" from the dropdown) to see what's being sent, and what the server itself logs.

## Settings

- `shario.enableBeta` (boolean, default `false`) — let **Shar: Update Server Binary** update onto a pre-release shario version, not just the newest stable one.

## Known limitations

- Doesn't yet apply or render edits made by other collaborators — only sends this editor's own changes out.
- One extension instance per workspace folder; no UI yet for switching which folder/server you're connected to beyond reconnecting.

## License

GNU General Public License v3 — same as the main [`shario`](https://github.com/Muna-Louis-Nwugo/shario) repo. Free to use, forever.
