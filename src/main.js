const fs = require('fs');
const path = require('path');
const flow = require('xml-flow');
const csInterface = new CSInterface();
const PANEL_STATE_PATH = path.join(__dirname, '..', 'panel_state.json');

let allPresets = [];
let filteredPresets = [];
let toastTimer = null;

const searchInput   = document.getElementById('searchInput');
const resultsEl     = document.getElementById('results');
const progressWrap  = document.getElementById('progressWrap');
const progressBar   = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const countEl       = document.getElementById('presetCount');
const emptyEl       = document.getElementById('emptyState');

// ── Settings Elements ────────────────────────────────────────────────────────
const settingsBtn     = document.getElementById('settingsBtn');
const settingsView    = document.getElementById('settingsView');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const shortcutBox     = document.getElementById('shortcutRecorder');
const shortcutLabel   = document.getElementById('shortcutLabel');
const rescanBtn       = document.getElementById('rescanBtn');

const DEFAULT_FOCUS_SHORTCUT = 'Ctrl+Alt+7';
let currentShortcut = localStorage.getItem('focusShortcut') || DEFAULT_FOCUS_SHORTCUT;
let isRecording = false;

let presetShortcuts = JSON.parse(localStorage.getItem('presetShortcuts') || '{}');
let recordingPresetId = null;
let panelStateTimer = null;
let lastPanelCommandId = '';

// Fallback state used only if Premiere refuses closeExtension().
// The normal shortcut path now truly closes the panel and lets the service reopen it.
let panelCollapsed = false;

function init() {
    migrateDefaultShortcut();
    loadPresets();
    initSettings();
    initSystemPanelBridge();
    if (rescanBtn) rescanBtn.addEventListener('click', forceRescan);
    searchInput.addEventListener('input', e => filterPresets(e.target.value));
    window.addEventListener('keydown', handleGlobalKeydown);
    try {
        const interest = JSON.stringify([{ "keyCode": 0, "ctrlKey": true }, { "keyCode": 0, "altKey": true }, { "keyCode": 0, "metaKey": true }]);
        csInterface.registerKeyEventsInterest(interest);
    } catch(e) {}
    // Sync the current shortcut to the shared config file so the background
    // service panel can read it on startup (before the user opens settings).
    _syncShortcutToFile(currentShortcut);
    checkAndAutoStartBridgeServer();
}

function migrateDefaultShortcut() {
    if (currentShortcut === 'Ctrl+Shift+G') {
        currentShortcut = DEFAULT_FOCUS_SHORTCUT;
        localStorage.setItem('focusShortcut', currentShortcut);
    }
}

function initSettings() {
    if (currentShortcut) shortcutLabel.textContent = currentShortcut;
    else toggleSettings(true);
    settingsBtn.addEventListener('click', () => toggleSettings());
    saveSettingsBtn.addEventListener('click', () => toggleSettings(false));
    shortcutBox.addEventListener('click', startRecording);
}

async function forceRescan() {
    if (rescanBtn) rescanBtn.classList.add('spinning');
    // Delete cache to force a full re-scan
    try {
        const cachePath = path.join(__dirname, '..', 'presets_cache.json');
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    } catch(e) {}
    allPresets = [];
    filteredPresets = [];
    if (countEl) countEl.textContent = '—';
    await loadPresets();
    if (rescanBtn) rescanBtn.classList.remove('spinning');
    showToast('Re-scan complete!', 'success');
}


function toggleSettings(force) {
    const isVisible = (typeof force === 'boolean') ? force : settingsView.classList.contains('hidden');
    if (isVisible) { settingsView.classList.remove('hidden'); settingsBtn.classList.add('active'); }
    else { settingsView.classList.add('hidden'); settingsBtn.classList.remove('active'); isRecording = false; shortcutBox.classList.remove('recording'); }
}

function startRecording() { isRecording = true; shortcutBox.classList.add('recording'); shortcutLabel.textContent = 'Recording…'; }

function handleGlobalKeydown(e) {
    if (isRecording || recordingPresetId) {
        e.preventDefault(); e.stopPropagation();

        // Escape cancels the recording
        if (e.key === 'Escape') {
            if (isRecording) {
                isRecording = false;
                shortcutBox.classList.remove('recording');
                shortcutLabel.textContent = currentShortcut || 'Click to record…';
            } else if (recordingPresetId) {
                cancelRecordingPreset();
            }
            return;
        }

        let keys = [];
        if (e.ctrlKey) keys.push('Ctrl'); if (e.metaKey) keys.push('Cmd'); if (e.altKey) keys.push('Alt'); if (e.shiftKey) keys.push('Shift');
        const keyName = e.key.charAt(0).toUpperCase() + e.key.slice(1);
        if (!['Control', 'Alt', 'Shift', 'Meta'].includes(keyName)) {
            keys.push(keyName); const shortcutStr = keys.join('+');
            if (isRecording) { currentShortcut = shortcutStr; localStorage.setItem('focusShortcut', shortcutStr); shortcutLabel.textContent = shortcutStr; isRecording = false; shortcutBox.classList.remove('recording'); _syncShortcutToFile(shortcutStr); _notifyServiceShortcut(shortcutStr); }
            else if (recordingPresetId) { presetShortcuts[recordingPresetId] = shortcutStr; localStorage.setItem('presetShortcuts', JSON.stringify(presetShortcuts)); recordingPresetId = null; document.querySelectorAll('.preset-row').forEach(r => r.classList.remove('recording-preset')); renderResults(true); }
        }
        return;
    }
    const combo = [];
    if (e.ctrlKey) combo.push('Ctrl'); if (e.metaKey) combo.push('Cmd'); if (e.altKey) combo.push('Alt'); if (e.shiftKey) combo.push('Shift');
    const keyName = e.key.charAt(0).toUpperCase() + e.key.slice(1);
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(keyName)) combo.push(keyName);
    const currentComboStr = combo.join('+');
    if (currentShortcut && currentComboStr === currentShortcut) {
        e.preventDefault();
        e.stopPropagation();
        closePanelFromShortcut();
        return;
    }
    for (const pid in presetShortcuts) { if (presetShortcuts[pid] === currentComboStr) { e.preventDefault(); e.stopPropagation(); const p = allPresets.find(item => item.id === pid); if (p) applyPreset(p); return; } }
}

function cancelRecordingPreset() {
    recordingPresetId = null;
    document.querySelectorAll('.preset-row').forEach(r => r.classList.remove('recording-preset'));
    renderResults(true);
}

function deletePresetShortcut(e, pid) {
    e.stopPropagation();
    delete presetShortcuts[pid];
    localStorage.setItem('presetShortcuts', JSON.stringify(presetShortcuts));
    renderResults(true);
    showToast('Shortcut removed', 'success');
}

function startRecordingPreset(e, pid) {
    e.stopPropagation();
    // If already recording this same preset, cancel
    if (recordingPresetId === pid) { cancelRecordingPreset(); return; }
    recordingPresetId = pid;
    document.querySelectorAll('.preset-row').forEach(r => r.classList.remove('recording-preset'));
    const rows = document.querySelectorAll('.preset-row');
    for (let i = 0; i < rows.length; i++) {
        if (filteredPresets[i] && filteredPresets[i].id === pid) { rows[i].classList.add('recording-preset'); const label = rows[i].querySelector('.btn-set'); if (label) label.textContent = 'ESC=cancel'; break; }
    }
}

function getAppPrefsPath() { return new Promise(resolve => csInterface.evalScript('app.getAppPrefPath', result => resolve((!result || result.indexOf('undefined') > -1) ? 'eval-error' : result))); }

function findPresetFiles() {
    var found = [];
    var docsPaths = [
        path.join(process.env.USERPROFILE, 'Documents', 'Adobe', 'Premiere Pro'),
        path.join(process.env.USERPROFILE, 'Documentos', 'Adobe', 'Premiere Pro'),
        path.join(process.env.USERPROFILE, 'OneDrive', 'Documents', 'Adobe', 'Premiere Pro'),
        path.join(process.env.USERPROFILE, 'OneDrive', 'Documentos', 'Adobe', 'Premiere Pro')
    ];
    function walk(dir, depth) {
        if (depth > 3) return;
        try {
            if (!fs.existsSync(dir)) return;
            var items = fs.readdirSync(dir);
            for (var k = 0; k < items.length; k++) {
                var full = path.join(dir, items[k]);
                var st = null;
                try { st = fs.statSync(full); } catch(e) { continue; }
                if (st.isDirectory()) {
                    walk(full, depth + 1);
                } else if (items[k] === 'Effect Presets and Custom Items.prfpset') {
                    if (found.indexOf(full) === -1) found.push(full);
                }
            }
        } catch(e) {}
    }
    for (var d = 0; d < docsPaths.length; d++) { walk(docsPaths[d], 0); }
    return found;
}

function showToast(msg, type) {
    const t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast ' + (type || 'success');
    void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 220); }, 2800);
}

async function loadPresets() {
    const cachePath = path.join(__dirname, '..', 'presets_cache.json');
    try {
        if (fs.existsSync(cachePath)) {
            try {
                const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                allPresets = cacheData.presets || [];
                if (allPresets.length > 0) { if (countEl) countEl.textContent = `${allPresets.length} presets (cached)`; filterPresets(''); renderResults(true); }
            } catch(e) {}
        }
        let prefsPath = await getAppPrefsPath();
        let filePathsToScan = findPresetFiles();

        // Also try the path from Premiere's API
        if (prefsPath !== 'eval-error') {
            const fp = path.join(prefsPath, 'Effect Presets and Custom Items.prfpset');
            if (fs.existsSync(fp) && filePathsToScan.indexOf(fp) === -1) {
                filePathsToScan.unshift(fp);
            }
        }

        if (filePathsToScan.length === 0) {
            const fallback = path.join(process.env.USERPROFILE, 'Documents', 'Adobe', 'Premiere Pro', '24.0', 'Profile-' + process.env.USERNAME, 'Effect Presets and Custom Items.prfpset');
            if (fs.existsSync(fallback)) filePathsToScan.push(fallback);
        }

        if (filePathsToScan.length === 0) { searchInput.placeholder = "File not found"; return; }

        // Compute a combined key: sum of all mtimes so any file change triggers re-scan
        let combinedMtime = 0;
        for (var mi = 0; mi < filePathsToScan.length; mi++) {
            try { combinedMtime += fs.statSync(filePathsToScan[mi]).mtimeMs; } catch(e) {}
        }
        // Also include file count in the key to detect newly added files
        combinedMtime += filePathsToScan.length * 1e12;

        let needsScan = true;
        if (fs.existsSync(cachePath)) {
            try {
                const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                if (cacheData.mtime === combinedMtime && Array.isArray(cacheData.presets) && cacheData.presets.length > 0) {
                    needsScan = false;
                }
            } catch(e) {}
        }

        if (needsScan) {
            searchInput.placeholder = 'Scanning\u2026'; progressWrap.style.display = 'flex';
            let allParsed = [];
            for (let i = 0; i < filePathsToScan.length; i++) {
                const fp = filePathsToScan[i];
                try {
                    const presets = await parsePrfpset(fp, (p) => {
                        if (progressBar) progressBar.style.width = (((i + p) / filePathsToScan.length) * 100) + '%';
                        searchInput.placeholder = `Scanning file ${i+1}/${filePathsToScan.length} (${Math.round(p*100)}%)...`;
                    });
                    allParsed = allParsed.concat(presets);
                } catch(e) { console.error('Error parsing', filePathsToScan[i], e); }
            }

            // Deduplicate across all files by ObjectID
            const seenIds = new Set();
            const finalDeduped = allParsed.filter(p => {
                if (!p.id || seenIds.has(p.id)) return false;
                seenIds.add(p.id);
                return true;
            });

            const stdFx = await getStandardEffects();
            allPresets = finalDeduped.concat(stdFx);
            fs.writeFileSync(cachePath, JSON.stringify({ mtime: combinedMtime, presets: allPresets }, null, 2));
            if (countEl) countEl.textContent = `${allPresets.length} presets`;
            filterPresets(''); renderResults(true);
        } else { searchInput.placeholder = 'Search presets\u2026'; }
        if (progressBar) progressBar.style.width = '100%';
        setTimeout(() => { progressWrap.classList.add('done'); setTimeout(() => progressWrap.style.display = 'none', 600); }, 200);
        
        // Comprobar atajos/comandos pendientes de BridgeGold (Cold Start)
        setTimeout(() => { _checkBridgePendingAction(); }, 350);
    } catch (err) { searchInput.placeholder = 'Load failed'; console.error('loadPresets error:', err); }
}

function getStandardEffects() {
    return new Promise(resolve => {
        csInterface.evalScript(`$._PPP_.getStandardEffects()`, result => {
            try {
                const data = JSON.parse(result); const res = [];
                if (data.video) data.video.forEach(fx => res.push({ name: fx.name, id: 'std_v_'+fx.name, type: 'Video Effect', isStandard: true, effects: [{ displayName: fx.name, matchName: fx.name, params: [] }] }));
                if (data.audio) data.audio.forEach(fx => res.push({ name: fx.name, id: 'std_a_'+fx.name, type: 'Audio Effect', isStandard: true, effects: [{ displayName: fx.name, matchName: fx.name, params: [] }] }));
                resolve(res);
            } catch(e) { resolve([]); }
        });
    });
}

// ── Parser ────────────────────────────────────────────────────────────────────
function parsePrfpset(filePath, progressCallback) {
    return new Promise((resolve, reject) => {
        const fileSize  = fs.statSync(filePath).size;
        let   bytesRead = 0;

        const raw = {
            TreeItem:             [],
            FilterPresetItem:     [],
            FilterPreset:         [],
            VideoFilterComponent: [],
            AudioFilterComponent: [],
            VideoComponentParam:  [],
            AudioComponentParam:  [],
            PointComponentParam:  [],
            ColorComponentParam:  [],
            ArbVideoComponentParam: []
        };

        const stream    = fs.createReadStream(filePath);
        const xmlStream = flow(stream, { strict: true, simplifyNodes: false });

        stream.on('data', chunk => {
            bytesRead += chunk.length;
            const pct = Math.min(bytesRead / fileSize, 1);
            if (progressCallback) progressCallback(pct);
        });

        // Flatten $attrs into the node
        function normalise(node) {
            if (node && node.$attrs) {
                Object.assign(node, node.$attrs);
                delete node.$attrs;
            }
            return node;
        }

        // Fix garbled Latin-1 encoding
        function fixEncoding(str) {
            if (!str || typeof str !== 'string') return str;
            return str
                .replace(/A1/g, 'á').replace(/A9/g, 'é').replace(/AD/g, 'í')
                .replace(/B3/g, 'ó').replace(/BA/g, 'ú').replace(/A3/g, 'ó')
                .replace(/C1/g, 'Á').replace(/C9/g, 'É').replace(/CD/g, 'Í')
                .replace(/D3/g, 'Ó').replace(/DA/g, 'Ú').replace(/BF/g, '¿')
                .replace(/A0/g, '\u00A0').replace(/\?\?/g, 'ñ').replace(/A4/g, 'ñ');
        }

        function convert64BitToBGRA(valStr) {
            if (!/^\d{17,}$/.test(valStr)) return valStr;
            try {
                const big = BigInt(valStr);
                const a = Number((big >> 48n) & 0xFFFFn) >> 8;
                const r = Number((big >> 32n) & 0xFFFFn) >> 8;
                const g = Number((big >> 16n) & 0xFFFFn) >> 8;
                const b = Number(big & 0xFFFFn) >> 8;
                const argb32 = (a << 24) | (r << 16) | (g << 8) | b;
                return argb32.toString();
            } catch(e) { return valStr; }
        }

        function processColorValues(str) {
            if (!str || typeof str !== 'string') return str;
            if (/^\d{17,}$/.test(str)) return convert64BitToBGRA(str);
            if (str.indexOf(',') > -1 && str.indexOf(';') === -1) {
                let parts = str.split(',');
                if (parts.length >= 2 && /^\d{17,}$/.test(parts[1])) parts[1] = convert64BitToBGRA(parts[1]);
                return parts.join(',');
            }
            if (str.indexOf(';') > -1) {
                let segments = str.split(';');
                for (let i = 0; i < segments.length; i++) {
                    if (!segments[i]) continue;
                    let parts = segments[i].split(',');
                    if (parts.length >= 2 && /^\d{17,}$/.test(parts[1])) parts[1] = convert64BitToBGRA(parts[1]);
                    segments[i] = parts.join(',');
                }
                return segments.join(';');
            }
            return str;
        }

        Object.keys(raw).forEach(tag => xmlStream.on('tag:' + tag, node => raw[tag].push(normalise(node))));

        xmlStream.on('end', () => {
            const results = [];

            const treeItems   = Array.isArray(raw.TreeItem)         ? raw.TreeItem         : (raw.TreeItem         ? [raw.TreeItem]         : []);
            const filterItems = Array.isArray(raw.FilterPresetItem) ? raw.FilterPresetItem : (raw.FilterPresetItem ? [raw.FilterPresetItem] : []);
            const filterPresets = Array.isArray(raw.FilterPreset)   ? raw.FilterPreset     : (raw.FilterPreset     ? [raw.FilterPreset]     : []);

            const fpiMap = {}; filterItems.forEach(fpi => { if (fpi.ObjectID) fpiMap[fpi.ObjectID] = fpi; });
            const fpMap = {}; filterPresets.forEach(fp => { if (fp.ObjectID) fpMap[fp.ObjectID] = fp; });

            const paramMap = {};
            if (raw.VideoComponentParam) raw.VideoComponentParam.forEach(p => paramMap[p.ObjectID] = p);
            if (raw.AudioComponentParam) raw.AudioComponentParam.forEach(p => paramMap[p.ObjectID] = p);
            if (raw.PointComponentParam) raw.PointComponentParam.forEach(p => paramMap[p.ObjectID] = p);
            if (raw.ColorComponentParam) raw.ColorComponentParam.forEach(p => paramMap[p.ObjectID] = p);
            if (raw.ArbVideoComponentParam) raw.ArbVideoComponentParam.forEach(p => paramMap[p.ObjectID] = p);

            function getText(val) {
                if (!val) return '';
                if (typeof val === 'string') return val.trim();
                if (val.$text) return String(val.$text).trim();
                const v = Object.values(val).find(x => typeof x === 'string');
                return v ? v.trim() : '';
            }

            treeItems.forEach((ti) => {
                try {
                    const base = ti.TreeItemBase;
                    if (!base) return;

                    let name = '';
                    if (typeof base === 'string') name = base.trim();
                    else if (base.$text) name = base.$text.trim();
                    else name = getText(base.Name);

                    if (!name) return;

                    const refID = getText(base.Data);
                    const fpi  = refID ? fpiMap[refID] : null;
                    if (!fpi) return; // Skip folders

                    let type   = 'Custom'; // User requested all custom presets to be labeled 'Custom'
                    let effects = [];

                    if (fpi) {
                        let fpRefs = [];
                        if (fpi.FilterPresets) {
                            const fps = fpi.FilterPresets;
                            if (fps.FilterPreset) fpRefs = Array.isArray(fps.FilterPreset) ? fps.FilterPreset : [fps.FilterPreset];
                            else if (fps.ObjectRef) fpRefs = Array.isArray(fps.ObjectRef) ? fps.ObjectRef : [fps.ObjectRef];
                        }

                        fpRefs.forEach(ref => {
                            const refId = typeof ref === 'string' ? ref.trim() : getText(ref.ObjectRef || ref);
                            const fpObj = refId ? fpMap[refId] : null;
                            if (!fpObj) return;

                            const compId = getText(fpObj.Component);
                            if (!compId) return;

                            const anchorType = parseInt(getText(fpObj.Type) || "0", 10);
                            const anchorIn = parseInt(getText(fpObj.AnchorInPoint) || "0", 10);
                            const anchorOut = parseInt(getText(fpObj.AnchorOutPoint) || "0", 10);

                            const vfc = raw.VideoFilterComponent.find(v => v.ObjectID === compId);
                            if (vfc && vfc.Component) {
                                const dn = getText(vfc.Component.DisplayName);
                                const mn = getText(vfc.MatchName) || getText(vfc.FilterMatchName);
                                
                                let params = [];
                                if (vfc.Component.Params && vfc.Component.Params.Param) {
                                    let pRefs = Array.isArray(vfc.Component.Params.Param) ? vfc.Component.Params.Param : [vfc.Component.Params.Param];
                                    pRefs.forEach(ref => {
                                        let pId = getText(ref.ObjectRef || ref);
                                        let pObj = paramMap[pId];
                                        
                                        if (pObj) {
                                            params.push({
                                                index: parseInt(ref.Index || ref.index || -1, 10),
                                                name: fixEncoding(getText(pObj.Name)),
                                                currentValue: processColorValues(getText(pObj.CurrentValue)),
                                                startKeyframe: processColorValues(getText(pObj.StartKeyframe)),
                                                isTimeVarying: getText(pObj.IsTimeVarying) === 'true',
                                                keyframes: processColorValues(getText(pObj.Keyframes))
                                            });
                                        }
                                    });
                                }
                                
                                if (dn) {
                                    const priorCount = effects.filter(e => e.matchName === mn).length;
                                    effects.push({ 
                                        displayName: dn, 
                                        matchName: mn, 
                                        anchorType: anchorType,
                                        anchorIn: anchorIn,
                                        anchorOut: anchorOut,
                                        instanceIndex: priorCount,
                                        params: params 
                                    });
                                }
                                return;
                            }

                            const afc = raw.AudioFilterComponent.find(a => a.ObjectID === compId);
                            if (afc && afc.AudioComponent && afc.AudioComponent.Component) {
                                const dn = getText(afc.AudioComponent.Component.DisplayName);
                                const mn = getText(afc.FilterMatchName) || getText(afc.MatchName);
                                if (dn) effects.push({ displayName: dn, matchName: mn });
                            }
                        });
                    }

                    results.push({ name, id: String(ti.ObjectID || ''), type, effects });
                } catch (e) {}
            });

            const seen   = new Set();
            const deduped = results.filter(p => {
                if (seen.has(p.id)) return false;
                seen.add(p.id);
                return true;
            });

            resolve(deduped);
        });

        xmlStream.on('error', reject);
    });
}

function filterPresets(q) { q = q.trim().toLowerCase(); filteredPresets = q.length === 0 ? allPresets : allPresets.filter(p => p.name.toLowerCase().includes(q)); renderResults(true); }

function renderResults(show) {
    resultsEl.innerHTML = ''; emptyEl.classList.add('hidden');
    if (!show) { resultsEl.classList.add('collapsed'); setTimeout(() => { if (resultsEl.classList.contains('collapsed')) resultsEl.classList.add('hidden'); }, 300); return; }
    resultsEl.classList.remove('hidden'); setTimeout(() => resultsEl.classList.remove('collapsed'), 10);
    if (filteredPresets.length === 0) { const eq = document.getElementById('emptyQuery'); if (eq) eq.textContent = '"' + searchInput.value + '"'; emptyEl.classList.remove('hidden'); return; }
    filteredPresets.forEach((p, i) => {
        const row = document.createElement('div'); row.className = 'preset-row' + (p.isStandard ? ' standard-fx' : '');
        row.style.animationDelay = Math.min(i * 18, 200) + 'ms';
        const hasShortcut = !!presetShortcuts[p.id];
        const s = hasShortcut ? presetShortcuts[p.id] : 'SET';
        const deleteBtnHtml = hasShortcut
            ? `<button class="row-btn btn-del-shortcut" title="Remove shortcut" onclick="deletePresetShortcut(event, '${p.id}')">&#x2715;</button>`
            : '';
        row.innerHTML = `<div class="row-icon">${escHtml(p.name.charAt(0).toUpperCase())}</div><div class="row-body"><span class="row-name">${escHtml(p.name)}</span><span class="row-type">${escHtml(p.type)}</span></div><div class="row-actions"><button class="row-btn btn-set" onclick="startRecordingPreset(event, '${p.id}')">${escHtml(s)}</button>${deleteBtnHtml}<button class="row-btn btn-apply">Apply</button></div>`;
        row.onclick = () => applyPreset(p, row); resultsEl.appendChild(row);
    });
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function applyPreset(p, row) {
    if (row) { row.classList.add('applying'); setTimeout(() => row.classList.remove('applying'), 800); }
    showToast('Applying…', 'success');
    if (!p.effects) return;
    const tf = path.join(__dirname, '..', 'presetgold_payload.json'); const sf = tf.replace(/\\/g, '\\\\');
    for (let i = 0; i < p.effects.length; i++) {
        fs.writeFileSync(tf, JSON.stringify({ name: p.name, effects: p.effects, effectIndex: i, action: "add" }, null, 2));
        await new Promise(r => csInterface.evalScript(`$._PPP_.applyPresetFromFile('${sf}')`, () => setTimeout(r, 350)));
        fs.writeFileSync(tf, JSON.stringify({ name: p.name, effects: p.effects, effectIndex: i, action: "apply" }, null, 2));
        await new Promise(r => csInterface.evalScript(`$._PPP_.applyPresetFromFile('${sf}')`, () => setTimeout(r, 50)));
    }
}

// ── Panel collapse / expand ───────────────────────────────────────────────────
// Fallback only: if closeExtension() is unavailable, hide the UI while keeping
// the panel runtime alive. The normal toggle path uses a real panel close.

function collapsePanel() {
    panelCollapsed = true;
    document.documentElement.classList.add('panel-collapsed');
    // Remove focus from any input so keyboard events still route to window
    if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
    }
}

function expandPanel() {
    panelCollapsed = false;
    document.documentElement.classList.remove('panel-collapsed');
    // Re-focus search after a short tick to allow layout to settle
    setTimeout(() => { searchInput.focus(); searchInput.select(); }, 50);
}

function closePanelFromShortcut() {
    _notifyServiceClosing();
    writePanelState(false);
    setTimeout(() => {
        try {
            csInterface.closeExtension();
        } catch(e) {
            collapsePanel();
            writePanelState(true);
        }
    }, 20);
}

// ── Helpers for background-service coordination ──────────────────────────────

function initSystemPanelBridge() {
    writePanelState(true);
    panelStateTimer = setInterval(() => writePanelState(true), 1000);

    try {
        csInterface.addEventListener('com.presetgold.panelCommand', function (event) {
            let command = {};
            try {
                command = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data || {});
            } catch(e) {}

            if (command.id && command.id === lastPanelCommandId) return;
            lastPanelCommandId = command.id || String(Date.now());

            if (command.action === 'open' || command.action === 'focus') {
                expandPanel();
                writePanelState(true);
            } else if (command.action === 'close' || command.action === 'toggle') {
                closePanelFromShortcut();
            }
        });
    } catch(e) {}

    // Event listener para recibir acciones del puente BridgeGold (Hot Start)
    try {
        csInterface.addEventListener('com.presetgold.bridgeAction', function (event) {
            let data = {};
            try {
                data = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data || {});
            } catch(e) {}

            if (data.action === 'applyPreset' && data.presetId) {
                const p = allPresets.find(item => item.id === data.presetId);
                if (p) {
                    applyPreset(p);
                }
            } else if (data.action === 'open') {
                expandPanel();
                writePanelState(true);
            } else if (data.action === 'close') {
                closePanelFromShortcut();
            } else if (data.action === 'toggle') {
                if (panelCollapsed) {
                    expandPanel();
                    writePanelState(true);
                } else {
                    closePanelFromShortcut();
                }
            }
        });
    } catch(e) {}

    window.addEventListener('beforeunload', function () {
        if (panelStateTimer) clearInterval(panelStateTimer);
        writePanelState(false);
    });

    setTimeout(() => {
        searchInput.focus();
        searchInput.select();
    }, 150);
}

function writePanelState(isOpen) {
    try {
        fs.writeFileSync(PANEL_STATE_PATH, JSON.stringify({
            loaded: !!isOpen,
            visible: !!isOpen && !panelCollapsed,
            collapsed: !!panelCollapsed,
            ts: Date.now()
        }, null, 2));
    } catch(e) {}
}

/**
 * Write the shortcut string to shortcut_config.json so the background service
 * panel can read it when Premiere starts (before the user opens settings).
 */
function _syncShortcutToFile(shortcutStr) {
    if (!shortcutStr) return;
    try {
        const cfgPath = path.join(__dirname, '..', 'shortcut_config.json');
        fs.writeFileSync(cfgPath, JSON.stringify({
            focusShortcut: shortcutStr,
            pythonHotkey: shortcutStr,
            updatedAt: Date.now()
        }, null, 2));
    } catch(e) {}
}

/**
 * Dispatch a CEP APPLICATION-scope event so the background service updates
 * its registerKeyEventsInterest immediately (no need to restart Premiere).
 */
function _notifyServiceShortcut(shortcutStr) {
    try {
        const ev = new CSEvent('com.presetgold.shortcutChanged', 'APPLICATION');
        ev.data = shortcutStr;
        csInterface.dispatchEvent(ev);
    } catch(e) {}
}

function _notifyServiceClosing() {
    try {
        const ev = new CSEvent('com.presetgold.panelClosing', 'APPLICATION');
        csInterface.dispatchEvent(ev);
    } catch(e) {}
}

/**
 * Verifica si hay alguna acción en cola pendiente desde BridgeGold (Cold Start)
 */
function _checkBridgePendingAction() {
    try {
        const pendingPath = path.join(__dirname, '..', '..', 'bridge_pending_action.json');
        if (fs.existsSync(pendingPath)) {
            const data = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
            // Eliminar cola inmediatamente para evitar bucles
            fs.unlinkSync(pendingPath);

            // Verificar vigencia del comando (menor a 30 segundos)
            if (Date.now() - Number(data.ts || 0) < 30000) {
                if (data.action === 'applyPreset' && data.presetId) {
                    const p = allPresets.find(item => item.id === data.presetId);
                    if (p) {
                        applyPreset(p);
                    }
                }
            }
        }
    } catch(e) {
        console.error("Error al procesar acción fría de BridgeGold:", e);
    }
}

function checkAndAutoStartBridgeServer() {
    fetch('http://localhost:4920/status')
        .then(res => res.json())
        .catch(() => {
            console.log('[PresetGold] BridgeGold server is not running. Attempting auto-start...');
            try {
                const extensionsDir = path.join(csInterface.getSystemPath(SystemPath.USER_DATA), 'Adobe', 'CEP', 'extensions');
                const bridgeServerPaths = [
                    path.join(extensionsDir, 'com.bridgegold.bridge', 'src', 'server.js'),
                    path.join(extensionsDir, 'com.bridgegold.bridge', 'server.js'),
                    'e:\\BridgeGold\\src\\server.js'
                ];
                let started = false;
                for (const p of bridgeServerPaths) {
                    if (fs.existsSync(p)) {
                        const script = document.createElement('script');
                        script.src = 'file:///' + p.replace(/\\/g, '/');
                        document.body.appendChild(script);
                        console.log('[PresetGold] BridgeGold server injected successfully from:', p);
                        started = true;
                        break;
                    }
                }
            } catch (err) {
                console.error('[PresetGold] Error auto-starting BridgeGold server:', err);
            }
        });
}

init();
