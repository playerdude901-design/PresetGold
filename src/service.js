'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  PresetGold Background Service
//  Runs silently in background (AutoVisible=false) inside Premiere Pro.
//  Listens for the configured shortcut and opens the main panel via CEP API.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const csService      = new CSInterface();
const MAIN_EXT_ID    = 'com.presetgold.search';
const CONFIG_PATH    = path.join(__dirname, '..', 'shortcut_config.json');
const COMMAND_PATH   = path.join(__dirname, '..', 'panel_command.json');
const COMMAND_ACK_PATH = path.join(__dirname, '..', 'panel_command_ack.json');
const PANEL_STATE_PATH = path.join(__dirname, '..', 'panel_state.json');

// ── Key-name → Windows virtual-key-code map ───────────────────────────────
// Key names match the output of:  e.key.charAt(0).toUpperCase() + e.key.slice(1)
// as used in main.js's handleGlobalKeydown shortcut recorder.
const KEY_CODES = (function () {
    const m = {};
    // A-Z  (65-90)
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { m[c] = 65 + i; });
    // 0-9  (48-57)
    for (let i = 0; i <= 9; i++) m[String(i)] = 48 + i;
    // F1-F12  (112-123)
    for (let i = 1; i <= 12; i++) m['F' + i] = 111 + i;
    // Arrow keys (stored as-is by main.js capitalisation)
    m['ArrowLeft'] = 37; m['ArrowUp'] = 38;
    m['ArrowRight'] = 39; m['ArrowDown'] = 40;
    // Common specials
    m[' '] = 32;    // Space
    m['Enter'] = 13; m['Tab'] = 9; m['Escape'] = 27;
    m['Backspace'] = 8; m['Delete'] = 46;
    m['Home'] = 36;  m['End'] = 35;
    m['Pageup'] = 33; m['PageUp'] = 33;
    m['Pagedown'] = 34; m['PageDown'] = 34;
    m['Insert'] = 45;
    // Numpad 0-9  (96-105)
    for (let i = 0; i <= 9; i++) m['Numpad' + i] = 96 + i;
    return m;
})();

// ── Parse "Ctrl+Shift+G" → { ctrlKey, altKey, shiftKey, metaKey, keyCode } ──
function parseShortcut(str) {
    if (!str) return null;
    const r = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, keyCode: 0 };
    str.split('+').forEach(part => {
        switch (part.trim()) {
            case 'Ctrl':  r.ctrlKey  = true; break;
            case 'Alt':   r.altKey   = true; break;
            case 'Shift': r.shiftKey = true; break;
            case 'Cmd':
            case 'Meta':  r.metaKey  = true; break;
            default:
                r.keyCode = KEY_CODES[part.trim()] || 0;
        }
    });
    return r.keyCode > 0 ? r : null;
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentParsed = null;   // Parsed shortcut object
let suppressOpen  = false;  // True for ~600 ms after the panel signals it is closing itself
let lastCommandId = '';

// ── Register CEP key interest for the current shortcut ────────────────────────
function applyShortcut(shortcutStr) {
    currentParsed = parseShortcut(shortcutStr);
    if (!currentParsed) return;

    // Intercept only the exact key combo so we don't steal unrelated keys
    try {
        csService.registerKeyEventsInterest(JSON.stringify([currentParsed]));
    } catch (e) {}
}

// ── Read shortcut from shared config file ─────────────────────────────────────
function readConfigFile() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return data.focusShortcut || '';
        }
    } catch (e) {}
    return '';
}

function readPanelState() {
    try {
        if (!fs.existsSync(PANEL_STATE_PATH)) return null;
        return JSON.parse(fs.readFileSync(PANEL_STATE_PATH, 'utf8'));
    } catch (e) {
        return null;
    }
}

function panelLooksOpen() {
    const state = readPanelState();
    if (!state || !state.loaded) return false;
    if (!state.visible || state.collapsed) return false;
    return (Date.now() - Number(state.ts || 0)) < 3000;
}

function panelLooksLoaded() {
    const state = readPanelState();
    if (!state || !state.loaded) return false;
    return (Date.now() - Number(state.ts || 0)) < 3000;
}

function writeCommandAck(id, action, handled) {
    try {
        fs.writeFileSync(COMMAND_ACK_PATH, JSON.stringify({
            id: id || '',
            action: action || '',
            handled: !!handled,
            ts: Date.now()
        }, null, 2));
    } catch (e) {}
}

function sendPanelCommand(action, id, source) {
    try {
        const ev = new CSEvent('com.presetgold.panelCommand', 'APPLICATION');
        ev.data = JSON.stringify({
            id: id || String(Date.now()),
            action: action,
            source: source || 'service',
            ts: Date.now()
        });
        csService.dispatchEvent(ev);
        return true;
    } catch (e) {
        return false;
    }
}

function openPanel() {
    try {
        csService.requestOpenExtension(MAIN_EXT_ID, '');
        return true;
    } catch (e) {
        return false;
    }
}

function togglePanel(id, source) {
    if (suppressOpen) {
        writeCommandAck(id, 'toggle', true);
        return;
    }

    if (panelLooksOpen()) {
        const sent = sendPanelCommand('close', id, source);
        writeCommandAck(id, 'close', sent);
    } else if (panelLooksLoaded()) {
        const sent = sendPanelCommand('open', id, source);
        writeCommandAck(id, 'open', sent);
    } else {
        const opened = openPanel();
        writeCommandAck(id, 'open', opened);
    }
}

function processExternalCommand(command) {
    if (!command || !command.id || command.id === lastCommandId) return;
    lastCommandId = command.id;

    if (command.createdAtUtc && !commandIsFresh(command.createdAtUtc)) {
        writeCommandAck(command.id, command.action || 'toggle', false);
        cleanupCommandFile();
        return;
    }

    if (command.action === 'open') {
        writeCommandAck(command.id, 'open', openPanel());
    } else if (command.action === 'close') {
        const sent = sendPanelCommand('close', command.id, command.source || 'external');
        writeCommandAck(command.id, 'close', sent);
    } else {
        togglePanel(command.id, command.source || 'external');
    }

    cleanupCommandFile();
}

function pollCommandFile() {
    try {
        if (!fs.existsSync(COMMAND_PATH)) return;
        const command = JSON.parse(fs.readFileSync(COMMAND_PATH, 'utf8'));
        processExternalCommand(command);
    } catch (e) {}
}

function commandIsFresh(createdAtUtc) {
    if (!/^\d{14}$/.test(createdAtUtc)) return true;
    const y = Number(createdAtUtc.slice(0, 4));
    const mo = Number(createdAtUtc.slice(4, 6)) - 1;
    const d = Number(createdAtUtc.slice(6, 8));
    const h = Number(createdAtUtc.slice(8, 10));
    const mi = Number(createdAtUtc.slice(10, 12));
    const s = Number(createdAtUtc.slice(12, 14));
    const createdMs = Date.UTC(y, mo, d, h, mi, s);
    return Math.abs(Date.now() - createdMs) < 60000;
}

function cleanupCommandFile() {
    try {
        if (fs.existsSync(COMMAND_PATH)) fs.unlinkSync(COMMAND_PATH);
    } catch (e) {}
}

// ── CEP event: main panel saved a new shortcut ────────────────────────────────
csService.addEventListener('com.presetgold.shortcutChanged', function (event) {
    applyShortcut(event.data || '');
});

// ── CEP event: main panel is closing itself → prevent service from re-opening it
csService.addEventListener('com.presetgold.panelClosing', function () {
    suppressOpen = true;
    setTimeout(() => { suppressOpen = false; }, 600);
});

// ── CEP key event: shortcut intercepted by the host ──────────────────────────
// registerKeyEventsInterest routes intercepted keys as DOM 'keydown' events
// on this panel's window (even while not visible).
window.addEventListener('keydown', function (e) {
    if (!currentParsed || suppressOpen) return;

    if (e.keyCode        === currentParsed.keyCode  &&
        !!e.ctrlKey      === currentParsed.ctrlKey   &&
        !!e.altKey       === currentParsed.altKey    &&
        !!e.shiftKey     === currentParsed.shiftKey  &&
        !!e.metaKey      === currentParsed.metaKey) {

        e.preventDefault();
        e.stopPropagation();

        togglePanel(String(Date.now()), 'cep-shortcut');
    }
});

// ── Initialise with value from shared config file ─────────────────────────────
applyShortcut(readConfigFile());
setInterval(pollCommandFile, 150);
