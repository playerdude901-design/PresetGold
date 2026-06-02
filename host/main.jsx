$._PPP_ = {

    applyPresetFromFile: function(filePath) {
        try {
            var f = new File(filePath);
            if (!f.exists) return JSON.stringify({ ok: false, msg: "Payload file not found." });
            f.open('r');
            var content = f.read();
            f.close();
            return this.applyPresetGold(content);
        } catch(e) {
            return JSON.stringify({ ok: false, msg: "File read error: " + e.toString() });
        }
    },

    applyPresetGold: function(payloadStr) {
        var log = [];
        try {
            var preset = JSON.parse(payloadStr);
            var activeSeq = app.project.activeSequence;
            if (!activeSeq) return JSON.stringify({ ok: false, msg: "No active sequence." });

            var selected = [];
            var vt = activeSeq.videoTracks;
            for (var i = 0; i < vt.numTracks; i++) {
                var clips = vt[i].clips;
                for (var j = 0; j < clips.numItems; j++) {
                    if (clips[j].isSelected()) {
                        selected.push({ clip: clips[j], trackIndex: i, startTicks: clips[j].start.ticks });
                    }
                }
            }

            if (selected.length === 0) return JSON.stringify({ ok: false, msg: "No clip selected." });

            app.enableQE();
            var qeDom = (typeof qe !== 'undefined') ? qe : null;
            if (!qeDom) return JSON.stringify({ ok: false, msg: "QE DOM not available." });
            var qeSeq = qeDom.project.getActiveSequence();
            if (!qeSeq) return JSON.stringify({ ok: false, msg: "QE Sequence not found." });

            var totalApplied = 0;
            for (var c = 0; c < selected.length; c++) {
                var res = this.applyToClip(selected[c], preset, qeDom, qeSeq);
                log.push("Clip " + c + ": " + res.msg);
                if (res.ok) totalApplied++;
            }

            return JSON.stringify({ ok: totalApplied > 0, msg: log.join(" | ") });

        } catch (e) {
            return JSON.stringify({ ok: false, msg: "Error: " + e.toString() });
        }
    },

    applyToClip: function(sel, preset, qeDom, qeSeq) {
        var clip = sel.clip;
        var trackIndex = sel.trackIndex;
        var startTicks = sel.startTicks;
        var clipLog = [];

        var INTRINSIC = {
            'AE.ADBE Opacity': 'AE.ADBE Opacity'
        };

        // ── Helper: always fetch a FRESH QE clip reference ──────────────────
        // After addVideoEffect the original reference becomes stale.
        // Re-scanning the track every time guarantees correctness for
        // multi-effect presets.
        function getFreshQeClip() {
            try {
                // Re-fetch QE sequence as well, as adding effects can sometimes 
                // invalidate the sequence object in the QE DOM
                var freshQeSeq = qeDom.project.getActiveSequence();
                if (!freshQeSeq) return null;
                var qeTrack = freshQeSeq.getVideoTrackAt(trackIndex);
                if (!qeTrack) return null;
                for (var t = 0; t < qeTrack.numItems; t++) {
                    var item = qeTrack.getItemAt(t);
                    if (item && Math.abs(Number(item.start.ticks) - Number(startTicks)) < 10000000) {
                        return item;
                    }
                }
            } catch(e) {}
            return null;
        }

        // Verify the clip is reachable before starting
        if (!getFreshQeClip()) return { ok: false, msg: "QE clip not found" };

        var effectsToApply = preset.effects;
        if (typeof preset.effectIndex !== 'undefined') {
            effectsToApply = [preset.effects[preset.effectIndex]];
        }

        var action = (typeof preset.action !== 'undefined') ? String(preset.action) : "both";

        for (var i = 0; i < effectsToApply.length; i++) {
            var effectDef = effectsToApply[i];
            var matchName = effectDef.matchName || '';
            var dispName  = effectDef.displayName || '';

            var intrinsicTarget = INTRINSIC[matchName] || null;
            var addedComp = null;

            if (intrinsicTarget) {
                if (action === "add") continue;
                for (var ci = 0; ci < clip.components.numItems; ci++) {
                    if (clip.components[ci].matchName === intrinsicTarget) {
                        addedComp = clip.components[ci];
                        break;
                    }
                }
            } else {
                if (action === "add" || action === "both") {
                    var fx = null;
                    var namesToTry = [matchName, dispName, "Transform", "Transformar", "Transformaci\u00f3n"];
                    if (matchName.indexOf("Geometry") > -1) {
                        namesToTry = ["Transform", "Transformar", "Transformaci\u00f3n", matchName, dispName];
                    }

                    for (var n = 0; n < namesToTry.length; n++) {
                        try {
                            fx = qeDom.project.getVideoEffectByName(namesToTry[n]);
                            if (fx && fx.name) break;
                            else fx = null;
                        } catch(e) { fx = null; }
                    }

                    if (!fx) {
                        clipLog.push("Effect not found: " + dispName + " / " + matchName);
                        if (action === "add") continue;
                    }

                    if (fx) {
                        var freshQeClip = getFreshQeClip();
                        if (freshQeClip) {
                            freshQeClip.addVideoEffect(fx);
                            clipLog.push("Triggered addVideoEffect for " + dispName);
                        } else {
                            clipLog.push("QE re-fetch failed for " + dispName);
                        }
                    }
                    
                    if (action === "add") continue;
                }

                if (action === "apply" || action === "both") {
                    for (var ac = 0; ac < clip.components.numItems; ac++) {
                        var compAfter = clip.components[ac];
                        var caM = ""; try { caM = compAfter.matchName; } catch(e) {}
                        var caD = ""; try { caD = compAfter.displayName; } catch(e) {}

                        if (caM === matchName || caD === dispName) {
                            addedComp = compAfter;
                            clipLog.push("Found target component '" + dispName + "' at index " + ac);
                            break; // Stop at the FIRST match (top of stack) to target the most recently added effect
                        }
                    }
                    
                    if (!addedComp) {
                        addedComp = clip.components[clip.components.numItems - 1];
                        clipLog.push("Target component not found, using last item fallback");
                    }
                }
            }

            if (!addedComp) {
                clipLog.push("Failed to find added component for " + dispName);
                continue;
            }

            try {
                this.applyParams(addedComp, effectDef, clip);
            } catch(e) {
                clipLog.push("Params failed for " + dispName + ": " + e.toString());
            }
            clipLog.push("Applied " + dispName);
        }

        return { ok: true, msg: clipLog.join(", ") };
    },

    applyParams: function(comp, effectDef, clip) {
        if (!effectDef.params) return;

        var ALIASES = [
            ["position", "posici\u00f3n", "posicion", "source point"],
            ["scale", "escala", "uniform scale", "escala uniforme"],
            ["scale width", "anchura de escala", "anchura"],
            ["scale height", "altura de escala", "altura"],
            ["rotation", "rotaci\u00f3n", "rotacion"],
            ["anchor point", "punto de anclaje"],
            ["opacity", "opacidad"],
            ["skew", "sesgar"],
            ["skew axis", "sesgar el eje", "eje de sesgo"],
            ["amount to tint", "cantidad de tinte", "cantidad"],
            ["map black to", "asignar negro a", "asociar negro a"],
            ["map white to", "asignar blanco a", "asociar blanco a"],
            ["tint", "tincci\u00f3n", "tinci\u00f3n", "tincion", "tincin", "tinci\u00f3n", "tinca3n"]
        ];

        function matchesName(n1, n2) {
            var s1 = n1.toLowerCase();
            var s2 = n2.toLowerCase();
            if (s1 === s2) return true;
            for (var a = 0; a < ALIASES.length; a++) {
                var group = ALIASES[a];
                var has1 = false, has2 = false;
                for (var k = 0; k < group.length; k++) {
                    if (s1 === group[k]) has1 = true;
                    if (s2 === group[k]) has2 = true;
                }
                if (has1 && has2) return true;
            }
            return false;
        }

        var anchorIn   = effectDef.anchorIn   || 0;
        var anchorOut  = effectDef.anchorOut  || 0;
        var anchorType = effectDef.anchorType || 0;
        var clipIn     = clip.inPoint.seconds;
        var clipOut    = clip.outPoint.seconds;
        var clipDur    = clipOut - clipIn;
        var presetDur  = (anchorOut - anchorIn) / 254016000000;

        for (var p = 0; p < effectDef.params.length; p++) {
            var pDef = effectDef.params[p];
            var prop = null;

            // Primary strategy: Exact index match (100% reliable across languages if present)
            if (typeof pDef.index !== 'undefined' && pDef.index >= 0 && pDef.index < comp.properties.numItems) {
                prop = comp.properties[pDef.index];
            }

            // Fallback strategy: Name matching (susceptible to localization issues)
            if (!prop) {
                for (var r = 0; r < comp.properties.numItems; r++) {
                    var pName = comp.properties[r].displayName.replace(/^\s+|\s+$/g, '');
                    var targetName = (pDef.name || '').replace(/^\s+|\s+$/g, '');
                    if (!targetName) continue;

                    if (matchesName(pName, targetName)) {
                        prop = comp.properties[r];
                        break;
                    }
                }
            }

            if (!prop) continue;

            if (pDef.isTimeVarying && pDef.keyframes) {
                try { prop.setTimeVarying(true); } catch(e) {}

                var kfList = pDef.keyframes.split(";");
                for (var k = 0; k < kfList.length; k++) {
                    var kfStr = kfList[k];
                    if (!kfStr || kfStr.replace(/\s/g, '') === '') continue;
                    var parts = kfStr.split(",");
                    if (parts.length < 3) continue;

                    var tSec   = parseInt(parts[0], 10) / 254016000000;
                    var relSec = tSec - (anchorIn / 254016000000);
                    var finalSec = clipIn + relSec;

                    if (anchorType === 0 && presetDur > 0) {
                        finalSec = clipIn + (relSec * (clipDur / presetDur));
                    } else if (anchorType === 2) {
                        finalSec = clipOut - ((anchorOut / 254016000000) - tSec);
                    }

                    var val;
                    if (parts[1].indexOf(":") > -1) {
                        var xy = parts[1].split(":");
                        val = [parseFloat(xy[0]), parseFloat(xy[1])];
                    } else {
                        val = parseFloat(parts[1]);
                    }

                    var tObj = new Time();
                    tObj.seconds = finalSec;
                    try {
                        prop.addKey(tObj);
                        prop.setValueAtKey(tObj, val, 1);
                        prop.setInterpolationTypeAtKey(tObj, parseInt(parts[2], 10) || 0, 1);
                    } catch(e) {}
                }

            } else if (pDef.startKeyframe || (pDef.currentValue !== undefined && pDef.currentValue !== null)) {
                var raw = "";

                if (pDef.startKeyframe) {
                    var skParts = pDef.startKeyframe.split(",");
                    if (skParts.length >= 2) {
                        raw = skParts[1];
                    }
                }

                if (!raw && pDef.currentValue !== undefined && pDef.currentValue !== null) {
                    raw = String(pDef.currentValue).replace(/^\s+|\s+$/g, '');
                }

                // We NO LONGER skip "0" or "0.0". If the preset explicitly defines the value as 0,
                // we must apply it (e.g. Tint amount, Temperature, etc).
                if (!raw) continue;

                if (pDef.name === "Uniform Scale" || pDef.name === "Escala uniforme") {
                    try { prop.setValue(true, 1); } catch(e) {}
                } else {
                    var sVal;
                    if (raw.indexOf(":") > -1) {
                        var sXY = raw.split(":");
                        sVal = [parseFloat(sXY[0]), parseFloat(sXY[1])];
                    } else if (raw === "true") {
                        sVal = true;
                    } else if (raw === "false") {
                        sVal = false;
                    } else if (/^-?\d+$/.test(raw)) {
                        // Whole integer — use parseInt to preserve exact color/flag values.
                        // parseFloat would corrupt negative ARGB color integers.
                        sVal = parseInt(raw, 10);
                    } else {
                        sVal = parseFloat(raw);
                    }
                    if (!isNaN(sVal) || typeof sVal === 'boolean' || (sVal instanceof Array)) {
                        try { prop.setValue(sVal, 1); } catch(e) {}
                    }
                }
            }
        }
    },

    getStandardEffects: function() {
        try {
            app.enableQE();
            var qeDom = (typeof qe !== 'undefined') ? qe : null;
            if (!qeDom) return JSON.stringify({ video: [], audio: [], msg: "QE not defined" });

            // DEEP DEBUGGING FOR CC 2024
            var methods = [];
            try {
                var props = qeDom.project.reflect.methods;
                for (var k = 0; k < props.length; k++) {
                    methods.push(props[k].name);
                }
            } catch(e) {}

            var results = { video: [], audio: [], debug_methods: methods };
            
            // Try different ways to get counts (QE versions vary)
            try {
                if (qeDom.project.getVideoEffectList) {
                    var vList = qeDom.project.getVideoEffectList();
                    for (var v = 0; v < vList.length; v++) {
                        results.video.push({ name: vList[v].name || vList[v] });
                    }
                } else {
                    var numV = 0;
                    if (qeDom.project.numVideoEffects !== undefined) numV = qeDom.project.numVideoEffects;
                    else if (qeDom.project.getVideoEffectCount) numV = qeDom.project.getVideoEffectCount();

                    for (var i = 0; i < numV; i++) {
                        var fx = qeDom.project.getVideoEffectAt(i);
                        if (fx && fx.name) {
                            results.video.push({ name: fx.name });
                        }
                    }
                }
            } catch(e) {}

            try {
                if (qeDom.project.getAudioEffectList) {
                    var aList = qeDom.project.getAudioEffectList();
                    for (var a = 0; a < aList.length; a++) {
                        results.audio.push({ name: aList[a].name || aList[a] });
                    }
                } else {
                    var numA = 0;
                    if (qeDom.project.numAudioEffects !== undefined) numA = qeDom.project.numAudioEffects;
                    else if (qeDom.project.getAudioEffectCount) numA = qeDom.project.getAudioEffectCount();

                    for (var j = 0; j < numA; j++) {
                        var afx = qeDom.project.getAudioEffectAt(j);
                        if (afx && afx.name) {
                            results.audio.push({ name: afx.name });
                        }
                    }
                }
            } catch(e) {}
            
            return JSON.stringify(results);
        } catch(e) {
            return JSON.stringify({ video: [], audio: [], error: e.toString() });
        }
    }
};
