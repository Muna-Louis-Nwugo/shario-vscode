/*
 * TESTING INSTRUCTIONS
 * WSL run "code ."
 * hit f5
 * CTRL + Shift + P
 * try running Shar: Connect or Shar: SendMessage
 */
const vscode = require('vscode');
const { io } = require('socket.io-client');

// socket persists across commands — one connection per VS Code session
let socket = null;

// output channel is VS Code's way of giving you a dedicated logging panel
// think of it like stdout but rendered in the IDE under "Output" > "Shar"
let outputChannel = null;

// activate() is called by VS Code when the extension first loads.
// context lets you register disposables — things VS Code will clean up
// when the extension is deactivated
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Shar');

    // registerCommand ties a string ID (defined in package.json under "contributes.commands")
    // to a handler function. the command palette calls this handler when the user picks it
    const connectCmd = vscode.commands.registerCommand('shar.connect', () => {

        // guard against double-connecting
        if (socket && socket.connected) {
            vscode.window.showInformationMessage('Already connected to Shar');
            return;
        }

        // io() opens a Socket.IO connection to the Shar server.
        // Socket.IO sits on top of WebSockets and handles reconnection,
        // namespaces, and rooms — your server uses the "/" namespace by default
        socket = io('http://127.0.0.1:1324');

        // 'connect' fires once the handshake with the server completes.
        // we immediately emit 'join' so the server puts this socket into
        // the "ide" room — matching your on_connect handler in main.rs
        socket.on('connect', () => {
            socket.emit('join', 'ide');
            vscode.window.showInformationMessage('Connected to Shar');
            outputChannel.appendLine('Connected to Shar server');
        });

        // 'message' is the event your server emits back via:
        //   socket.within(data.room).emit("message", &message)
        // data here will be shaped like MessageOut: { success: bool, message: string }
        socket.on('message', (data) => {
            outputChannel.appendLine(`Received: ${JSON.stringify(data)}`);
        });

        socket.on('disconnect', () => {
            vscode.window.showWarningMessage('Disconnected from Shar');
            outputChannel.appendLine('Disconnected from Shar server');
        });
    });

    const sendCmd = vscode.commands.registerCommand('shar.sendMessage', async () => {
        if (!socket || !socket.connected) {
            vscode.window.showErrorMessage('Not connected. Run "Shar: Connect" first.');
            return;
        }

        // showInputBox opens a text prompt in the command palette.
        // returns undefined if the user hits Escape, so we bail early
        const val = await vscode.window.showInputBox({ prompt: 'Enter message value' });
        if (val === undefined) return;

        // this shape maps directly to your MessageIn struct:
        //   room: String  -> which room to route to on the server
        //   val: String   -> the payload
        //   input: bool   -> whether this is an input-type message
        const message = {
            room: 'ide',
            val: val,
            input: true
        };

        // 'input' matches the socket.on("input", ...) handler in main.rs
        socket.emit('input', message);
        outputChannel.appendLine(`Sent: ${JSON.stringify(message)}`);
    });

    // pushing to subscriptions ensures VS Code disposes these
    // commands when the extension deactivates — prevents memory leaks
    context.subscriptions.push(connectCmd, sendCmd);
}

// deactivate() is called when VS Code shuts down or the extension is disabled.
// close the socket cleanly so the server doesn't hold a dead connection
function deactivate() {
    if (socket) socket.disconnect();
}

module.exports = { activate, deactivate };
