/*
 * TESTING INSTRUCTIONS
 * WSL run "code ."
 * hit f5
 * CTRL + Shift + P
 * run "Shar: Connect" (make sure your shar server is already running and the
 * connected workspace folder matches the directory the server loaded)
 * then just type/delete in a file that's part of that shar
 *
 * This client is send-only: it forwards every keystroke as an "ide-add"/
 * "remove" event, and does nothing with anything the server sends back
 * (no "network-add"/"network-remove" handling yet -- that's a later pass,
 * once the server side reports back where a remote op actually landed).
 *
 * Pre-existing content (loaded from disk before this client connects) gets
 * its real (id, peer) filled in by an "initial-state" event the server is
 * expected to send once, right after "join" -- see `reconcileIdentities`.
 * NOT YET SENT BY THE SERVER: until that event exists, deleting
 * pre-existing content sends `id: null, peer: null`, which the server
 * can't resolve. Only characters typed after connecting (which get a real
 * identity via "ide-add-confirmed") can be removed correctly today.
 *
 * Expected "initial-state" payload: `{ file_path, lines }`, where `lines`
 * mirrors the server's own per-line projection -- one array per line, each
 * entry a raw `[id, peer]` pair, with index 0 being that line's anchor (the
 * root sentinel for line 0, the creating newline for every other line).
 *
 * A large burst of adds/deletes used to be able to crash the server (a
 * position-based parent reference could permanently orphan a character
 * deleted before its own add landed) -- fixed by making IdeAdd's parent
 * identity/tag-based instead of position-based (see the shar repo's
 * info/TODO.md "1.1" entry and info/BENCHMARK.md). `maybeRestartServer`
 * still auto-restarts the server if it ever dies for an unrelated reason.
 */
const vscode = require('vscode');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

// the shar server process, if this extension is the one that (re)started it
// -- null if the user launched it themselves, in which case we don't own its
// lifecycle and won't try to restart it
let sharProcess = null;

// assumes the dev layout: shario-vscode and shario are sibling directories
// under the same parent. Update this if that ever changes.
const SHAR_DIR = path.resolve(__dirname, '..', 'shario');

// socket persists across commands -- one connection per VS Code session
let socket = null;

// output channel is VS Code's way of giving you a dedicated logging panel
// think of it like stdout but rendered in the IDE under "Output" > "Shar"
let outputChannel = null;

// the workspace root we joined with -- only documents under this root get
// forwarded, so we don't try to send edits to files the server never loaded
let connectedRoot = null;

// Per tracked document: an array of lines mirroring VS Code's own line/
// character model. Each line has its own "anchor" (the server-side
// line-start identity -- the root sentinel for line 0, the newline that
// created every other line) plus an array of cells, one per real character.
//
// Every add this client sends gets a disposable local "tag" -- a number
// that only exists to correlate an eventual server confirmation back to
// the specific pending add it belongs to. It has nothing to do with real
// CRDT identity (that's the server's own counter, untouched here) -- it's
// the same idea as a request id in any request/response protocol. A cell's
// tag gets cleared and replaced with a real (id, peer) once confirmed.
// Pre-existing content loaded from disk starts with neither a tag nor a
// known id/peer, since this client never "sent" it and doesn't need to
// track it -- removing it just goes out by position immediately, same as
// it always did.
//
// cell / anchor shape: { value?: char, id: number|null, peer: number|null, tag: number|null }
const docState = new Map(); // uri string -> Array<{ anchor, cells: Array<cell> }>

// tag -> { filePath, row, col, isWholeLine } -- a remove that arrived before
// its own target's add was confirmed, waiting for that specific tag to
// resolve into a real identity
const pendingRemovals = new Map();

// tag -> the cell/anchor object itself, so a confirmation can fill in its
// real identity in place without having to re-locate it in docState
const pendingAdds = new Map();

// file_path -> the `lines` snapshot from "initial-state", held only when it
// arrives before we've built local state for that file -- docState is built
// lazily per open document, not for the whole shar up front, so join order
// isn't guaranteed
const pendingSnapshots = new Map();

let nextTag = 0;

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Shar');

    const connectCmd = vscode.commands.registerCommand('shar.connect', async () => {
        if (socket && socket.connected) {
            vscode.window.showInformationMessage('Already connected to Shar');
            return;
        }

        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('Open a workspace folder before connecting to Shar.');
            return;
        }
        connectedRoot = folders[0].uri.fsPath;

        // io() opens a Socket.IO connection to the Shar server. Socket.IO sits
        // on top of WebSockets and handles reconnection, namespaces, and
        // rooms -- your server uses the "/" namespace by default
        socket = io('http://127.0.0.1:3000');

        // 'connect' fires every time the transport handshake completes --
        // the first connect and any automatic reconnect socket.io does on
        // its own. The shar reads file contents from disk, not from open
        // editor buffers, so unsaved changes are flushed right before each
        // and every one of those, not just the first: whatever the server
        // is about to load (or reload) needs to match what's open. `false`
        // skips untitled files, which have no disk path to save to anyway.
        socket.on('connect', async () => {
            await vscode.workspace.saveAll(false);

            socket.emit('join', { local: true, path: connectedRoot });
            vscode.window.showInformationMessage('Connected to Shar');
            outputChannel.appendLine(`Connected to Shar server, joined as local for ${connectedRoot}`);

            // seed local state with whatever's already open, so the very
            // first edit in each has something to work against
            for (const doc of vscode.workspace.textDocuments) {
                if (isTrackedDocument(doc)) {
                    getOrCreateLines(doc);
                }
            }
        });

        socket.on('disconnect', () => {
            vscode.window.showWarningMessage('Disconnected from Shar');
            outputChannel.appendLine('Disconnected from Shar server');
            maybeRestartServer();
        });

        // NOT YET SENT BY THE SERVER -- see the file-level comment.
        socket.on('ide-add-confirmed', (data) => {
            const pending = pendingAdds.get(data.tag);
            if (!pending) return;
            pendingAdds.delete(data.tag);
            pending.id = data.id;
            pending.peer = data.peer;
            pending.tag = null;

            const waiting = pendingRemovals.get(data.tag);
            if (waiting) {
                pendingRemovals.delete(data.tag);
                emitRemove(waiting.filePath, waiting.row, waiting.col, waiting.isWholeLine, pending.id, pending.peer);
            }
        });

        // NOT YET SENT BY THE SERVER -- see the file-level comment. Fills in
        // real (id, peer) for pre-existing content, matching by position:
        // that's only safe here because nothing has been edited since the
        // moment this client saved and the server loaded the same bytes off
        // disk, which is exactly when this event fires.
        socket.on('initial-state', (data) => {
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === data.file_path);
            const key = doc && doc.uri.toString();
            if (key && docState.has(key)) {
                reconcileIdentities(docState.get(key), data.lines);
            } else {
                // not open yet, or docState for it hasn't been built --
                // getOrCreateLines picks this up once it is
                pendingSnapshots.set(data.file_path, data.lines);
            }
        });
    });

    const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
        const doc = event.document;
        if (!socket || !socket.connected) return;
        if (!isTrackedDocument(doc)) return;

        const lines = getOrCreateLines(doc);

        for (const change of event.contentChanges) {
            handleChange(doc.uri.fsPath, lines, change);
        }
    });

    // pushing to subscriptions ensures VS Code disposes these when the
    // extension deactivates -- prevents leaked listeners/connections
    context.subscriptions.push(connectCmd, changeListener);
}

function isTrackedDocument(doc) {
    return doc.uri.scheme === 'file' && connectedRoot && doc.uri.fsPath.startsWith(connectedRoot);
}

// Builds the local line/cell mirror for a document's current text. Every
// cell starts with no tag and no known id/peer -- row 0's sentinel aside,
// this is pre-existing content, so its real (id, peer) isn't known yet and
// has to wait on "initial-state" (see `getOrCreateLines`/`reconcileIdentities`).
function buildInitialState(text) {
    return text.split('\n').map((line, i) => ({
        anchor: i === 0 ? { id: 0, peer: 0, tag: null } : { id: null, peer: null, tag: null },
        cells: [...line].map((value) => ({ value, id: null, peer: null, tag: null })),
    }));
}

// Returns `doc`'s local mirror, building it (and applying any "initial-state"
// snapshot that arrived before this document was even open) the first time
// it's needed.
function getOrCreateLines(doc) {
    const key = doc.uri.toString();
    let lines = docState.get(key);
    if (lines) return lines;

    lines = buildInitialState(doc.getText());
    docState.set(key, lines);

    const snapshot = pendingSnapshots.get(doc.uri.fsPath);
    if (snapshot) {
        pendingSnapshots.delete(doc.uri.fsPath);
        reconcileIdentities(lines, snapshot);
    }

    return lines;
}

// Fills in real (id, peer) for pre-existing content from the server's
// "initial-state" snapshot, matching purely by position -- see the comment
// on the "initial-state" handler for why that's safe here specifically.
// Each entry is a raw `[id, peer]` pair (the server just serializes its own
// (IdSize, PeerIdSize) tuples), not an `{ id, peer }` object.
function reconcileIdentities(lines, serverLines) {
    for (let i = 0; i < serverLines.length && i < lines.length; i++) {
        const [anchorInfo, ...cellInfos] = serverLines[i];
        const line = lines[i];

        if (anchorInfo) {
            [line.anchor.id, line.anchor.peer] = anchorInfo;
        }

        for (let j = 0; j < cellInfos.length && j < line.cells.length; j++) {
            [line.cells[j].id, line.cells[j].peer] = cellInfos[j];
        }
    }
}

// Decomposes one VS Code content change into "ide-add"/"remove" emits,
// updating `lines` (this document's local mirror) in lockstep so later
// changes can look up each character's current identity state.
function handleChange(filePath, lines, change) {
    const startLine = change.range.start.line;
    const startCol = change.range.start.character;

    if (change.rangeLength > 0) {
        removeRange(filePath, lines, startLine, startCol, change.rangeLength);
    }

    if (change.text.length > 0) {
        insertText(filePath, lines, startLine, startCol, change.text);
    }
}

// Walks the deleted range forward, removing cells from the local mirror one
// at a time. Order doesn't matter for correctness here the way it used to:
// once removal targets a real identity instead of a raw position, a
// duplicate or reordered request can't land on the wrong element anymore --
// it either matches the id it was meant for, or the server doesn't find it.
function removeRange(filePath, lines, startLine, startCol, rangeLength) {
    let row = startLine;
    let col = startCol;
    let remaining = rangeLength;

    while (remaining > 0) {
        const line = lines[row];
        if (col >= line.cells.length) {
            // nothing left on this line -- the next character being deleted
            // is the newline ending it, which merges the line below up into
            // this one
            removeAnchor(filePath, lines, row + 1);
            remaining -= 1;
            continue;
        }

        const [cell] = line.cells.splice(col, 1);
        removeIdentity(filePath, cell, row, col, false);
        remaining -= 1;
    }
}

function removeAnchor(filePath, lines, lineIndex) {
    const line = lines[lineIndex];
    lines[lineIndex - 1].cells.push(...line.cells);
    lines.splice(lineIndex, 1);
    removeIdentity(filePath, line.anchor, lineIndex, 0, true);
}

// Sends the remove now if this identity is already known (a confirmed add,
// or pre-existing content); otherwise holds it until the add it belongs to
// resolves, since we don't know what to tell the server yet.
function removeIdentity(filePath, identity, row, col, isWholeLine) {
    if (identity.tag !== null) {
        pendingRemovals.set(identity.tag, { filePath, row, col, isWholeLine });
        return;
    }
    emitRemove(filePath, row, col, isWholeLine, identity.id, identity.peer);
}

function insertText(filePath, lines, startLine, startCol, text) {
    let row = startLine;
    let col = startCol;

    for (const ch of text) {
        const tag = nextTag++;
        // the cell/anchor immediately before the insertion point -- referenced
        // by its real (id, peer) if already known, or by its own tag if it's
        // this same client's own not-yet-confirmed add
        const parent = col === 0 ? lines[row].anchor : lines[row].cells[col - 1];

        if (ch === '\n') {
            const anchor = { id: null, peer: null, tag };
            pendingAdds.set(tag, anchor);
            const moved = lines[row].cells.splice(col);
            lines.splice(row + 1, 0, { anchor, cells: moved });
            emitAdd(filePath, parent, row, ch, tag);
            row += 1;
            col = 0;
        } else {
            const cell = { value: ch, id: null, peer: null, tag };
            pendingAdds.set(tag, cell);
            lines[row].cells.splice(col, 0, cell);
            emitAdd(filePath, parent, row, ch, tag);
            col += 1;
        }
    }
}

function emitAdd(filePath, parent, lineHint, val, tag) {
    const payload = {
        file_path: filePath,
        parent_id: parent.tag === null ? parent.id : null,
        parent_peer: parent.tag === null ? parent.peer : null,
        parent_tag: parent.tag,
        val: val,
        tag: tag,
        line_hint: lineHint,
    };
    socket.emit('ide-add', payload);
    outputChannel.appendLine(`ide-add: ${JSON.stringify(payload)}`);
}

function emitRemove(filePath, row, col, isWholeLine, id, peer) {
    const payload = {
        file_path: filePath,
        row: row,
        col: col,
        is_whole_line: isWholeLine,
        // not part of IdeRemove's real shape yet -- harmless extra fields,
        // here so removal can switch to identity-based targeting once the
        // server side supports it without another client-side change
        id: id ?? null,
        peer: peer ?? null,
    };
    socket.emit('remove', payload);
    outputChannel.appendLine(`remove: ${JSON.stringify(payload)}`);
}

// Called on every "disconnect". If the server process is actually gone (not
// just a transient network blip -- socket.io retries those on its own), spawn
// it again. We don't reconnect ourselves: socket.io's own automatic
// reconnection keeps probing the port and will pick it up once it's back,
// which re-fires the existing "connect" handler (re-saves, re-joins) the same
// as any other reconnect.
async function maybeRestartServer() {
    if (await isServerUp()) return; // still alive -- not what killed the connection
    outputChannel.appendLine('Shar server appears to have died -- attempting to restart it...');
    if (!startSharProcess()) return; // error already shown

    const up = await waitForServerUp(30000);
    if (up) {
        outputChannel.appendLine('Shar server restarted -- waiting for it to reconnect...');
    } else {
        vscode.window.showErrorMessage('Shar server did not come back up -- check the Shar output channel.');
    }
}

// Starts the shar server as a child process via `cargo run` (rebuilds
// automatically if the code changed). Returns false (after showing an error)
// if spawning itself failed; true otherwise.
function startSharProcess() {
    if (sharProcess) return true; // already (re)started by us this session

    outputChannel.appendLine(`Launching Shar server via "cargo run" in ${SHAR_DIR}`);
    try {
        sharProcess = spawn('cargo', ['run'], { cwd: SHAR_DIR });
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to launch Shar server: ${err.message}`);
        return false;
    }

    sharProcess.stdout.on('data', (data) => outputChannel.append(data.toString()));
    sharProcess.stderr.on('data', (data) => outputChannel.append(data.toString()));
    sharProcess.on('error', (err) => {
        vscode.window.showErrorMessage(`Failed to launch Shar server: ${err.message}`);
        sharProcess = null;
    });
    sharProcess.on('exit', (code) => {
        outputChannel.appendLine(`Shar server process exited with code ${code}`);
        sharProcess = null;
    });

    return true;
}

function isServerUp() {
    return new Promise((resolve) => {
        const probe = net.connect({ port: 3000, host: '127.0.0.1' }, () => {
            probe.end();
            resolve(true);
        });
        probe.on('error', () => resolve(false));
    });
}

function waitForServerUp(timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = async () => {
            if (await isServerUp()) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(tick, 300);
        };
        tick();
    });
}

function deactivate() {
    if (socket) socket.disconnect();
    // only kill it if we're the ones who (re)started it -- not a server the
    // user started themselves outside VS Code
    if (sharProcess) sharProcess.kill();
}

module.exports = { activate, deactivate };
