# Shario VS Code Extension

The VS Code client for [Shario](https://github.com/Muna-Louis-Nwugo/shario), a real-time collaborative text editor backend built on a CRDT. This extension is the IDE half: it forwards every keystroke to a running `shar` server and applies whatever the server confirms, so multiple editors attached to the same server stay in sync.

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
- **Shar: Disconnect** — ends the current session: disconnects the socket, and stops the server process too if this extension is the one that (re)started it.

Type or delete in a tracked file afterward — check the **"Shar"** output channel (`View > Output`, select "Shar" from the dropdown) to see what's being sent, and what the server itself logs.

## Settings

- `shario.enableBeta` (boolean, default `false`) — let **Shar: Update Server Binary** update onto a pre-release shario version, not just the newest stable one.

## Known limitations

- A remote edit whose parent/target this client has never seen gets dropped, not guessed — this client only keeps live characters in memory, never tombstones, so an op referencing something already removed can't be resolved. Rare in practice (it needs two edits racing right at the same spot), and never corrupts anything; the edit is just silently skipped.
- A remote edit only gets applied if the target file is already open in an editor here — there's no mechanism yet to open a file just because a peer edited it.
- One extension instance per workspace folder; no UI yet for switching which folder/server you're connected to beyond reconnecting.

## License

GNU General Public License v3 — same as the main [`shario`](https://github.com/Muna-Louis-Nwugo/shario) repo. Free to use, forever.
