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
 */
const vscode = require('vscode');
const { io } = require('socket.io-client');

// socket persists across commands -- one connection per VS Code session
let socket = null;

// output channel is VS Code's way of giving you a dedicated logging panel
// think of it like stdout but rendered in the IDE under "Output" > "Shar"
let outputChannel = null;

// the workspace root we joined with -- only documents under this root get
// forwarded, so we don't try to send edits to files the server never loaded
let connectedRoot = null;

// shar's char-by-char protocol needs to know each edit's *pre-edit* text to
// figure out what got deleted (VS Code's change event only gives a range +
// length, not the actual deleted text, and by the time the event fires the
// document already reflects the *new* content) -- so we keep our own copy
// of every open document's text, updated after every change we process
const shadowText = new Map(); // uri string -> last-known full text

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

        // the shar reads file contents from disk, not from open editor
        // buffers -- flush any unsaved changes first so what it loads
        // matches what's actually open. `false` skips untitled files,
        // which have no disk path to save to anyway
        await vscode.workspace.saveAll(false);

        // io() opens a Socket.IO connection to the Shar server. Socket.IO sits
        // on top of WebSockets and handles reconnection, namespaces, and
        // rooms -- your server uses the "/" namespace by default
        socket = io('http://127.0.0.1:3000');

        // 'connect' fires once the transport handshake completes. we then
        // emit 'join' with { local, path } -- matching the current server's
        // Connect struct -- to actually initialize the shar and join "local"
        socket.on('connect', () => {
            socket.emit('join', { local: true, path: connectedRoot });
            vscode.window.showInformationMessage('Connected to Shar');
            outputChannel.appendLine(`Connected to Shar server, joined as local for ${connectedRoot}`);

            // seed the shadow cache with whatever's already open, so the
            // very first edit in each has something to diff against
            for (const doc of vscode.workspace.textDocuments) {
                if (isTrackedDocument(doc)) {
                    shadowText.set(doc.uri.toString(), doc.getText());
                }
            }
        });

        socket.on('disconnect', () => {
            vscode.window.showWarningMessage('Disconnected from Shar');
            outputChannel.appendLine('Disconnected from Shar server');
        });
    });

    const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
        const doc = event.document;
        if (!socket || !socket.connected) return;
        if (!isTrackedDocument(doc)) return;

        const key = doc.uri.toString();
        const oldText = shadowText.get(key) ?? '';

        for (const change of event.contentChanges) {
            handleChange(doc.uri.fsPath, oldText, change);
        }

        // record the post-edit text for next time, now that we're done
        // diffing against the pre-edit version
        shadowText.set(key, doc.getText());
    });

    // pushing to subscriptions ensures VS Code disposes these when the
    // extension deactivates -- prevents leaked listeners/connections
    context.subscriptions.push(connectCmd, changeListener);
}

function isTrackedDocument(doc) {
    return doc.uri.scheme === 'file' && connectedRoot && doc.uri.fsPath.startsWith(connectedRoot);
}

// Decomposes one VS Code content change into a sequence of single-character
// "ide-add"/"remove" emits, in the order the server needs to see them.
function handleChange(filePath, oldText, change) {
    const startLine = change.range.start.line;
    const startCol = change.range.start.character;

    if (change.rangeLength > 0) {
        const startOffset = rowColToOffset(oldText, startLine, startCol);
        const deleted = oldText.substring(startOffset, startOffset + change.rangeLength);
        for (const ch of deleted) {
            if (ch === '\n') {
                // this newline starts the line right after it; removing it
                // merges that line into `startLine`. every subsequent
                // deletion in this same run still targets `startLine` (or
                // `startLine + 1` for another newline) because removal
                // shifts everything after it back into the same spot
                emitRemove(filePath, startLine + 1, 0, true);
            } else {
                emitRemove(filePath, startLine, startCol, false);
            }
        }
    }

    if (change.text.length > 0) {
        let row = startLine;
        let col = startCol;
        for (const ch of change.text) {
            const isStartOfLine = col === 0;
            // parent is the character right before this one; for a
            // start-of-line insert the server resolves the parent via the
            // line's start anchor instead, so parentCol is unused there
            emitAdd(filePath, row, isStartOfLine ? 0 : col - 1, ch, isStartOfLine);
            if (ch === '\n') {
                row += 1;
                col = 0;
            } else {
                col += 1;
            }
        }
    }
}

function rowColToOffset(text, row, col) {
    let offset = 0;
    let line = 0;
    while (line < row) {
        const next = text.indexOf('\n', offset);
        // if we run out of newlines before reaching `row`, the position is
        // past the end of what we have cached -- clamp to end of text
        if (next === -1) return text.length;
        offset = next + 1;
        line += 1;
    }
    return offset + col;
}

function emitAdd(filePath, parentRow, parentCol, val, startLine) {
    const payload = {
        file_path: filePath,
        parent_row: parentRow,
        parent_col: parentCol,
        val: val,
        start_line: startLine,
    };
    socket.emit('ide-add', payload);
    outputChannel.appendLine(`ide-add: ${JSON.stringify(payload)}`);
}

function emitRemove(filePath, row, col, isWholeLine) {
    const payload = {
        file_path: filePath,
        row: row,
        col: col,
        is_whole_line: isWholeLine,
    };
    socket.emit('remove', payload);
    outputChannel.appendLine(`remove: ${JSON.stringify(payload)}`);
}

function deactivate() {
    if (socket) socket.disconnect();
}

module.exports = { activate, deactivate };
