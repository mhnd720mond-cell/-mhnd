const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

const CHANNELS_FILE = './channels.json';
const AUTH_DIR = './auth_info';
const TARGET_PHONE_NUMBER = "967771939563"; // الرقم الأساسي: يستقبل الأوامر والتنبيهات من البوت
const SESSION_PHONE_NUMBER = "967774410169"; // رقم الجلسة: الرقم الذي تُربط به الجلسة ويُطلب له كود الاقتران

let BOT_START_TIME = Date.now();
let CHANNELS_CONFIG = [];
let sock = null;
let isStarting = false;
let isSendingQueue = false;
const REACT_QUEUE = []; // طابور إرسال منظم لتخفيف ضغط المعالج على الاستضافة المجانية

function getFormattedDateTime(date = new Date()) {
    return date.toLocaleString('ar-YE', {
        timeZone: 'Asia/Aden',
        hour12: true,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric'
    });
}

function getCorrectArabicDay(date = new Date()) {
    const options = { timeZone: 'Asia/Aden', weekday: 'long' };
    return new Intl.DateTimeFormat('ar-YE', options).format(date);
}

// تنظيف المخلفات والملفات الزائدة من مجلد الجلسة مع حماية ملفات الاعتماد الأساسية
function cleanSessionJunk() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return;
        const files = fs.readdirSync(AUTH_DIR);
        let removedCount = 0;

        for (const file of files) {
            // الإبقاء الدائم على creds.json لتجنب فصل الجلسة
            if (file === 'creds.json') continue;

            const isPreKey = file.startsWith('pre-key-');
            const isTempOrBak = file.endsWith('.tmp') || file.endsWith('.bak') || file.endsWith('.log');

            if (isPreKey || isTempOrBak) {
                const fullPath = path.join(AUTH_DIR, file);
                try {
                    const stat = fs.statSync(fullPath);
                    const ageMs = Date.now() - stat.mtimeMs;
                    if (isTempOrBak || (isPreKey && ageMs > 6 * 60 * 60 * 1000)) {
                        fs.unlinkSync(fullPath);
                        removedCount++;
                    }
                } catch (_) {}
            }
        }

        if (removedCount > 0) {
            console.log(`🧹 تم تنظيف ${removedCount} ملف زائد من الجلسة لتخفيف التخزين والذاكرة.`);
        }
    } catch (e) {
        console.log("⚠️ تعذر تنظيف مخلفات الجلسة:", e.message);
    }
}

let LAST = {};
let USER_STATE = {};
let TEMP_ADD_DATA = {};
let TEMP_EMOJI_DATA = {};
let TEMP_SUFFIX_DATA = {};

// تنظيف أرقام ومصفوفات غير مستخدمة في الذاكرة وملف القنوات لتخفيف الحجم
function pruneUnusedData() {
    const activeJids = new Set(CHANNELS_CONFIG.map(c => c.jid).filter(Boolean));
    for (const jid of Object.keys(LAST)) {
        if (!activeJids.has(jid)) {
            delete LAST[jid];
        }
    }

    for (const ch of CHANNELS_CONFIG) {
        if (Array.isArray(ch.history) && ch.history.length > 0) ch.history = [];
        if (Array.isArray(ch.deductionHistory) && ch.deductionHistory.length > 0) ch.deductionHistory = [];
    }
}

function loadChannels() {
    if (fs.existsSync(CHANNELS_FILE)) {
        try {
            let savedData = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
            CHANNELS_CONFIG = savedData.map(ch => ({
                code: ch.code,
                name: ch.name,
                jid: ch.jid || null,
                count: typeof ch.count === 'number' ? ch.count : 0,
                startDate: ch.startDate || getFormattedDateTime(),
                lastPostTime: ch.lastPostTime || null,
                paused: typeof ch.paused === 'boolean' ? ch.paused : false,
                maxLimit: typeof ch.maxLimit === 'number' ? ch.maxLimit : 0,
                lastKnownNum: typeof ch.lastKnownNum === 'number' ? ch.lastKnownNum : 0,
                status: ch.status || "نشطة",
                limitInfo: ch.limitInfo || { mode: "غير محدد", remaining: null },
                history: [],
                startDay: ch.startDay || `${getCorrectArabicDay()} (${getFormattedDateTime()})`,
                goalCount: ch.goalCount || null,
                deductionTotal: typeof ch.deductionTotal === 'number' ? ch.deductionTotal : 0,
                deductionHistory: [],
                noIgnore: typeof ch.noIgnore === 'boolean' ? ch.noIgnore : false,
                reactMode: typeof ch.reactMode === 'boolean' ? ch.reactMode : false,
                customEmojis: ch.customEmojis || null,
                customSuffix: ch.customSuffix || null
            }));
            pruneUnusedData();
        } catch (e) {
            CHANNELS_CONFIG = [];
        }
    }
}

let saveTimer = null;
function saveChannels(immediate = false) {
    const writeNow = () => {
        try {
            pruneUnusedData();
            fs.writeFileSync(CHANNELS_FILE, JSON.stringify(CHANNELS_CONFIG, null, 2));
        } catch (e) {
            console.log("❌ خطأ أثناء حفظ ملف القنوات:", e);
        }
    };

    if (immediate) {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        writeNow();
        return;
    }

    if (!saveTimer) {
        saveTimer = setTimeout(() => {
            saveTimer = null;
            writeNow();
        }, 1500);
    }
}

loadChannels();
cleanSessionJunk();

// تنظيف دوري للمخلفات والبيانات الزائدة كل ساعتين لتخفيف التخزين والذاكرة والمعالج
setInterval(() => {
    cleanSessionJunk();
    pruneUnusedData();
    if (typeof global.gc === 'function') {
        try { global.gc(); } catch (_) {}
    }
}, 2 * 60 * 60 * 1000);

function nameMatches(a, b) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

if (CHANNELS_CONFIG.length === 0) {
    let now = new Date();
    CHANNELS_CONFIG = [{
        code: "0029Vb9FZTa9sBIHN33KUP0O",
        name: "شخصية",
        jid: null,
        count: 0,
        startDate: getFormattedDateTime(now),
        lastPostTime: null,
        paused: false,
        maxLimit: 0,
        lastKnownNum: 0,
        status: "لم ينشر بعد",
        limitInfo: { mode: "غير محدد", remaining: null },
        history: [],
        startDay: `${getCorrectArabicDay(now)} (${getFormattedDateTime(now)})`,
        goalCount: null,
        deductionTotal: 0,
        deductionHistory: [],
        noIgnore: false,
        reactMode: false,
        customEmojis: null,
        customSuffix: null
    }];
    saveChannels(true);
}

process.on('uncaughtException', (err) => { console.log('Uncaught Exception:', err); });
process.on('unhandledRejection', (err) => { console.log('Unhandled Rejection:', err); });

// معالجة طابور الإرسال إلى الرقم الأساسي بشكل متسلسل وهادئ لمنع اختناق المعالج
async function processReactQueue() {
    if (isSendingQueue) return;
    isSendingQueue = true;

    try {
        while (REACT_QUEUE.length > 0) {
            const item = REACT_QUEUE.shift();
            if (!sock || !sock.ws || sock.ws.readyState !== 1) {
                REACT_QUEUE.unshift(item);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            await sock.sendMessage(`${TARGET_PHONE_NUMBER}@s.whatsapp.net`, { text: item.text }).catch(() => {});
            await new Promise(r => setTimeout(r, 350));
        }
    } finally {
        isSendingQueue = false;
    }
}

function enqueueOwnerCommand(text) {
    if (REACT_QUEUE.length > 100) {
        REACT_QUEUE.splice(0, REACT_QUEUE.length - 100);
    }
    REACT_QUEUE.push({ text });
    processReactQueue();
}

async function startBot() {
    if (isStarting) return;
    isStarting = true;

    try {
        if (sock) {
            try {
                sock.ev.removeAllListeners();
                sock.end();
            } catch (e) {}
            sock = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        const logger = pino({ level: 'silent' });

        sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: state.keys },
            logger,
            browser: Browsers.ubuntu('Chrome'),
            markOnlineOnConnect: false,
            syncFullHistory: false,
            getMessage: async () => undefined
        });

        sock.ev.on('creds.update', saveCreds);

        if (!state.creds.registered) {
            setTimeout(async () => {
                try {
                    if (!sock || state.creds.registered) return;
                    console.log(`⏳ جاري طلب رمز الاقتران بـ 8 أرقام لرقم الجلسة (${SESSION_PHONE_NUMBER})...`);
                    let phoneNumber = SESSION_PHONE_NUMBER.replace(/[^0-9]/g, '');
                    let code = await sock.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    console.log(`\n========================================`);
                    console.log(`🔑 رمز الاقتران الخاص بك هو: [ ${code} ]`);
                    console.log(`========================================\n`);
                } catch (err) {
                    console.log("❌ حدث خطأ أثناء طلب رمز الاقتران.");
                }
            }, 5000);
        }

        sock.ev.on('connection.update', async (u) => {
            const { connection, lastDisconnect } = u;
            if (connection === 'open') {
                isStarting = false;
                console.log("⚡ البوت متصل بنجاح وجاهز لاستقبال الأوامر...");
                setTimeout(async () => {
                    let updated = false;
                    for (let ch of CHANNELS_CONFIG) {
                        if (!ch.jid && ch.code && sock) {
                            try {
                                let meta = await sock.newsletterMetadata("invite", ch.code);
                                if (meta?.id) {
                                    ch.jid = meta.id;
                                    updated = true;
                                    await sock.newsletterFollow(meta.id).catch(() => {});
                                    await new Promise(r => setTimeout(r, 500));
                                }
                            } catch (e) {}
                        }
                    }
                    if (updated) saveChannels(true);
                }, 3000);
            }
            if (connection === 'close') {
                isStarting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔌 انقطع الاتصال، الكود: ${statusCode}`);

                if (sock) {
                    try { sock.ev.removeAllListeners(); } catch (e) {}
                    sock = null;
                }

                setTimeout(() => {
                    startBot();
                }, 5000);
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            let incomingMessages = m.messages || [];
            if (incomingMessages.length === 0) return;

            let newsletterMsgs = incomingMessages.filter(msg => {
                let rJid = jidNormalizedUser(msg?.key?.remoteJid);
                return msg && msg.message && rJid?.includes('@newsletter') && !msg.key.fromMe;
            });

            if (newsletterMsgs.length > 0) {
                let channelUpdates = {};
                for (let msg of newsletterMsgs) {
                    let rJid = jidNormalizedUser(msg.key.remoteJid);
                    let num = parseInt(msg.newsletterServerId || msg.key.server_id);
                    if (isNaN(num)) continue;

                    if (!channelUpdates[rJid]) channelUpdates[rJid] = [];
                    channelUpdates[rJid].push(num);
                }

                let anyChannelChanged = false;

                for (let remoteJid in channelUpdates) {
                    try {
                        let targetChannel = CHANNELS_CONFIG.find(c => c.jid === remoteJid);
                        if (!targetChannel || targetChannel.paused) continue;

                        if (targetChannel._skipOld) {
                            let maxNum = Math.max(...channelUpdates[remoteJid]);
                            if (!targetChannel.noIgnore) {
                                targetChannel.lastKnownNum = maxNum;
                                LAST[remoteJid] = maxNum;
                                targetChannel._skipOld = false;
                                anyChannelChanged = true;
                                continue;
                            } else {
                                targetChannel._skipOld = false;
                                anyChannelChanged = true;
                            }
                        }

                        let uniqueNums = [...new Set(channelUpdates[remoteJid])].sort((a, b) => a - b);
                        let latestNumInBatch = uniqueNums[uniqueNums.length - 1];

                        if (!LAST[remoteJid]) {
                            LAST[remoteJid] = targetChannel.lastKnownNum || uniqueNums[0] - 1;
                        }

                        let startNum = LAST[remoteJid] + 1;
                        let totalMissed = latestNumInBatch - startNum + 1;

                        if (targetChannel.noIgnore && totalMissed > 10) {
                            startNum = latestNumInBatch - 10 + 1;
                        } else {
                            if (startNum < uniqueNums[0]) {
                                startNum = uniqueNums[0];
                            }
                        }

                        if (startNum > latestNumInBatch) continue;

                        for (let currentNum = startNum; currentNum <= latestNumInBatch; currentNum++) {
                            if (targetChannel.maxLimit > 0 && targetChannel.count >= targetChannel.maxLimit) {
                                targetChannel.paused = true;
                                targetChannel.status = "متوقفة (بلغت الهدف)";
                                anyChannelChanged = true;
                                enqueueOwnerCommand(`⚠️ *تنبيه توقف قناة!*\n\nلقد وصلت قناة *[${targetChannel.name}]* إلى الهدف المحدد (${targetChannel.maxLimit}) وتم إيقافها تلقائياً!`);
                                break;
                            }
                            targetChannel.count++;
                            targetChannel.lastPostTime = getFormattedDateTime();
                            targetChannel.lastKnownNum = currentNum;
                            LAST[remoteJid] = currentNum;
                            anyChannelChanged = true;

                            let link = `https://whatsapp.com/channel/${targetChannel.code}/${currentNum}`;

                            if (targetChannel.reactMode) {
                                let emojis = targetChannel.customEmojis || "❤️,😮,👍,🙏,😂,😢";
                                let suffix = targetChannel.customSuffix ? ` ${targetChannel.customSuffix}` : "";
                                enqueueOwnerCommand(`.chreact ${link} ${emojis}${suffix}`);
                            } else {
                                enqueueOwnerCommand(`.chreact ${link}`);
                            }
                        }
                    } catch (channelErr) {
                        console.log("❌ خطأ داخل حلقة معالجة القناة:", channelErr);
                    }
                }

                if (anyChannelChanged) {
                    saveChannels();
                }
            }

            // معالجة الأوامر والدردشة الخاصة كما هي بدون تغيير في منطق الأوامر
            for (let msg of incomingMessages) {
                try {
                    if (!msg || !msg.message) continue;
                    let remoteJid = jidNormalizedUser(msg.key.remoteJid);
                    let textMsg = msg.message.conversation ||
                                  msg.message.extendedTextMessage?.text ||
                                  msg.message.ephemeralMessage?.message?.conversation || "";
                    let isFromMe = msg.key.fromMe;

                    if (remoteJid?.includes('@newsletter')) continue;

                    if (textMsg && !remoteJid.includes('@g.us') && !remoteJid.includes('@newsletter')) {
                        let cmd = textMsg.trim();
                        let targetUser = remoteJid;
                        let quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                        let quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || "";
                        let isReplyToBot = quotedText.length > 0;

                        if (cmd.startsWith(".chreact")) {
                            let senderPhone = remoteJid.replace(/[^0-9]/g, '');
                            let ownerPhone = TARGET_PHONE_NUMBER.replace(/[^0-9]/g, '');

                            if (senderPhone === ownerPhone || isFromMe) {
                                continue;
                            }

                            await sock.sendMessage(targetUser, {
                                text: `✨ *تنبيه مهم لكم* ✨\n\nعزيزي المشترك،\nالميزة اللي كنت تستخدمها الآن *مقفلة مؤقتاً من قبل المالك / مهند* 🔒\n\nبس لا تزعل، جهزنا لك شي أقوى 🔥\n\n🚀 *الآن متوفرة ميزة التفاعل التلقائي في القنوات*\n\nتبغى قناتك تكون نشطة وتفاعلها نار؟ 🔥\nالبوت بيتفاعل لك تلقائياً بالرياكشن اللي تختاره انت.\n\n🎁 *هدية لك:*\nأول ما تراسلنا بنعطيك *30 رسالة مجانية* يتفاعل عليها البوت، جرب بنفسك وشوف الفرق!\n\n📌 *تبغى أكثر من 30؟*\nسهلة جداً، كل اللي عليك تجيب متابعين لقناتنا، وبنعطيك مقابلهم تفاعل كثير.\n*مثال: لكل 50 متابع = 200 رسالة تفاعل مجاناً* 😍\n\n📩 للاشتراك والاستفسار، راسل رقم التنبيهات:\n📱 http://wa.me/${SESSION_PHONE_NUMBER}`
                            });
                            continue;
                        }

                        if (cmd.startsWith("تغيير ايموجي ") || cmd.startsWith("تغير ايموجي ")) {
                            let chName = cmd.replace(/^(تغيير ايموجي|تغير ايموجي)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                USER_STATE[targetUser] = "WAITING_CUSTOM_EMOJIS";
                                TEMP_EMOJI_DATA[targetUser] = { channelName: targetChannel.name };
                                await sock.sendMessage(targetUser, { text: `🎨 *تخصيص إيموجيات قناة (${targetChannel.name})*\n\nالخطوة 1️⃣: اعمل *رد (Reply)* على هذه الرسالة وأرسل قائمة الإيموجيات الجديدة التي تريدها:` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد قناة بهذا الاسم.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("تغيير رقم ") || cmd.startsWith("تغير رقم ")) {
                            let chName = cmd.replace(/^(تغيير رقم|تغير رقم)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                USER_STATE[targetUser] = "WAITING_CHANGE_SUFFIX";
                                TEMP_SUFFIX_DATA[targetUser] = { channelName: targetChannel.name };
                                await sock.sendMessage(targetUser, { text: `📌 *تغيير الرقم أو الرمز لقناة (${targetChannel.name})*\n\nالرجاء عمل *رد (Reply)* على هذه الرسالة وأرسل الرقم أو الرمز الجديد (مثل: \`#1\` أو \`#7\`):` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد قناة بهذا الاسم.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("كنسل ايموجي ") || cmd.startsWith("الغاء ايموجي ")) {
                            let chName = cmd.replace(/^(كنسل ايموجي|الغاء ايموجي)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.customEmojis = null;
                                targetChannel.customSuffix = null;
                                targetChannel.reactMode = false;
                                saveChannels(true);
                                await sock.sendMessage(targetUser, { text: `🔄 *تم إلغاء الإيموجيات المخصصة لقناة (${targetChannel.name}) بنجاح!*\nعادت القناة لترسل الروابط بالشكل الطبيعي.` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد قناة بهذا الاسم.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("تحويل ") || cmd.startsWith("تفعيل تحويل ")) {
                            let chName = cmd.replace(/^(تفعيل تحويل|تحويل)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.reactMode = true;
                                saveChannels(true);
                                let activeEmojis = targetChannel.customEmojis || "❤️,😮,👍,🙏,😂,😢";
                                let activeSuffix = targetChannel.customSuffix ? ` ${targetChannel.customSuffix}` : "";
                                await sock.sendMessage(targetUser, { text: `✅ *تم تفعيل وضع التحويل للقناة (${targetChannel.name}) بنجاح!*\nالإيموجيات المفعلة: \`${activeEmojis}${activeSuffix}\`` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد قناة بهذا الاسم لتفعيل التحويل.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("إيقاف تحويل ") || cmd.startsWith("ايقاف تحويل ")) {
                            let chName = cmd.replace(/^(إيقاف تحويل|ايقاف تحويل)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.reactMode = false;
                                saveChannels(true);
                                await sock.sendMessage(targetUser, { text: `🔄 *تم إيقاف وضع التحويل لقناة (${targetChannel.name}) بنجاح!* \nعادت لتحويل الروابط بالشكل الطبيعي.` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد قناة بهذا الاسم.` });
                            }
                            continue;
                        }

                        if (cmd === "المدة" || cmd === "مدة") {
                            let elapsedMs = Date.now() - BOT_START_TIME;
                            let totalMinutes = Math.floor(elapsedMs / (1000 * 60));
                            let days = Math.floor(totalMinutes / (60 * 24));
                            let hours = Math.floor((totalMinutes % (60 * 24)) / 60);
                            let minutes = totalMinutes % 60;

                            let timeString = days > 0
                                ? `*${days} يوم و ${hours} ساعة و ${minutes} دقيقة*`
                                : `*${hours} ساعة و ${minutes} دقيقة*`;

                            await sock.sendMessage(targetUser, { text: `⏱️ *مدة تشغيل البوت الحالية:*\nالبوت يعمل منذ: ${timeString} 🟢` });
                            continue;
                        }

                        if (cmd === "تصفير المدة" || cmd === "صفر المدة") {
                            BOT_START_TIME = Date.now();
                            await sock.sendMessage(targetUser, { text: `🔄 *تم تصفير عداد مدة التشغيل بنجاح!*` });
                            continue;
                        }

                        if (cmd === "إلغاء" || cmd === "الغاء") {
                            USER_STATE[targetUser] = null;
                            TEMP_ADD_DATA[targetUser] = null;
                            TEMP_EMOJI_DATA[targetUser] = null;
                            TEMP_SUFFIX_DATA[targetUser] = null;
                            await sock.sendMessage(targetUser, { text: "❌ تم إلغاء العملية بنجاح." });
                            continue;
                        }

                        if (USER_STATE[targetUser]) {
                            if (!isReplyToBot) continue;

                            if (USER_STATE[targetUser] === "WAITING_CHANGE_SUFFIX") {
                                let newSuffix = cmd.trim();
                                let suffixData = TEMP_SUFFIX_DATA[targetUser];

                                if (suffixData && suffixData.channelName) {
                                    let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, suffixData.channelName));
                                    if (targetChannel) {
                                        if (newSuffix === "لا" || newSuffix === "لا يوجد" || newSuffix === "بدون") {
                                            targetChannel.customSuffix = null;
                                            await sock.sendMessage(targetUser, { text: `✅ *تم إزالة الرقم/الرمز اللاحق لقناة (${targetChannel.name}) بنجاح.*` });
                                        } else {
                                            targetChannel.customSuffix = newSuffix;
                                            await sock.sendMessage(targetUser, { text: `🎉 *تم تغيير وحفظ الرقم/الرمز (${targetChannel.customSuffix}) لقناة (${targetChannel.name}) بنجاح!*` });
                                        }
                                        saveChannels(true);
                                    }
                                }
                                USER_STATE[targetUser] = null;
                                TEMP_SUFFIX_DATA[targetUser] = null;
                                continue;
                            }

                            if (USER_STATE[targetUser] === "WAITING_CUSTOM_EMOJIS") {
                                let emojisText = cmd.trim();
                                if (emojisText) {
                                    TEMP_EMOJI_DATA[targetUser].emojis = emojisText;
                                    USER_STATE[targetUser] = "WAITING_CUSTOM_SUFFIX";
                                    await sock.sendMessage(targetUser, { text: `✅ *تم حفظ الإيموجيات بنجاح!*\n\n📝 الخطوة 2️⃣: *هل هناك رقم أو رمز معين تريد إضافته إلى نهاية الإيموجيات؟* (مثل: \`#7\` أو \`&4\`) \n\n(رد بـ رسالة تحتوي الرمز، أو اكتب \`لا\` إذا كنت لا تريد إضافة أي شيء):` });
                                } else {
                                    await sock.sendMessage(targetUser, { text: "⚠️ يرجى إرسال نص الإيموجيات بشكل صحيح." });
                                }
                                continue;
                            }

                            if (USER_STATE[targetUser] === "WAITING_CUSTOM_SUFFIX") {
                                let suffixInput = cmd.trim();
                                let emojiData = TEMP_EMOJI_DATA[targetUser];

                                if (emojiData && emojiData.channelName) {
                                    let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, emojiData.channelName));
                                    if (targetChannel) {
                                        targetChannel.customEmojis = emojiData.emojis;

                                        if (suffixInput === "لا" || suffixInput === "لا يوجد" || suffixInput === "بدون") {
                                            targetChannel.customSuffix = null;
                                        } else {
                                            targetChannel.customSuffix = suffixInput;
                                        }

                                        targetChannel.reactMode = true;
                                        saveChannels(true);

                                        let savedSuffixMsg = targetChannel.customSuffix ? ` والرمز: \`${targetChannel.customSuffix}\`` : "";
                                        await sock.sendMessage(targetUser, { text: `🎉 *تم تغيير وحفظ إيموجي قناة (${targetChannel.name}) بنجاح!*${savedSuffixMsg}\nتم تفعيل التحويل لهذه القناة تلقائياً.` });
                                    }
                                }

                                USER_STATE[targetUser] = null;
                                TEMP_EMOJI_DATA[targetUser] = null;
                                continue;
                            }

                            if (USER_STATE[targetUser] === "WAITING_ADD_LINK") {
                                let code = "";
                                if (cmd.includes("whatsapp.com/channel/")) {
                                    let parts = cmd.split("whatsapp.com/channel/")[1].split("/");
                                    code = parts[0].trim();
                                } else {
                                    code = cmd.replace(/[^a-zA-Z0-9]/g, "");
                                }
                                try {
                                    let meta = await sock.newsletterMetadata("invite", code);
                                    if (meta && meta.id) {
                                        TEMP_ADD_DATA[targetUser] = { code: code, jid: meta.id };
                                        USER_STATE[targetUser] = "WAITING_ADD_NAME";
                                        await sock.sendMessage(targetUser, { text: `✅ تم جلب القناة بنجاح!\n\n📝 *الآن رد (Reply) على هذه الرسالة وأرسل اسم القناة:*` });
                                    } else {
                                        await sock.sendMessage(targetUser, { text: "⚠️ تعذر جلب معلومات القناة." });
                                    }
                                } catch (e) {
                                    await sock.sendMessage(targetUser, { text: "❌ حدث خطأ، تأكد من صحة الرابط." });
                                }
                                continue;
                            }

                            if (USER_STATE[targetUser] === "WAITING_ADD_NAME") {
                                let customName = cmd.trim();
                                let tempData = TEMP_ADD_DATA[targetUser];
                                if (tempData && customName) {
                                    let now = new Date();
                                    let currentDayName = getCorrectArabicDay(now);
                                    let formattedTime = getFormattedDateTime(now);
                                    let newCh = {
                                        code: tempData.code,
                                        name: customName,
                                        jid: tempData.jid,
                                        count: 0,
                                        startDate: formattedTime,
                                        lastPostTime: null,
                                        paused: false,
                                        maxLimit: 0,
                                        lastKnownNum: 0,
                                        status: "لم ينشر بعد",
                                        limitInfo: { mode: "غير محدد", remaining: null },
                                        history: [],
                                        startDay: `${currentDayName} (${formattedTime})`,
                                        goalCount: null,
                                        deductionTotal: 0,
                                        deductionHistory: [],
                                        noIgnore: false,
                                        reactMode: false,
                                        customEmojis: null,
                                        customSuffix: null
                                    };
                                    CHANNELS_CONFIG.push(newCh);
                                    saveChannels(true);
                                    await sock.newsletterFollow(tempData.jid).catch(() => {});
                                    USER_STATE[targetUser] = null;
                                    TEMP_ADD_DATA[targetUser] = null;
                                    await sock.sendMessage(targetUser, { text: `🎉 *تم حفظ وإضافة قناة (${customName}) بنجاح وبدأت مراقبتها!*` });
                                }
                                continue;
                            }

                            if (USER_STATE[targetUser] === "WAITING_DELETE") {
                                let targetIndex = CHANNELS_CONFIG.findIndex(c => c.name === cmd || c.code === cmd);
                                if (targetIndex === -1 && !isNaN(parseInt(cmd))) {
                                    let idx = parseInt(cmd) - 1;
                                    if (idx >= 0 && idx < CHANNELS_CONFIG.length) targetIndex = idx;
                                }
                                USER_STATE[targetUser] = null;
                                if (targetIndex !== -1) {
                                    let deleted = CHANNELS_CONFIG.splice(targetIndex, 1)[0];
                                    saveChannels(true);
                                    await sock.sendMessage(targetUser, { text: `🗑️ تم حذف قناة *[${deleted.name}]* بنجاح!` });
                                } else {
                                    await sock.sendMessage(targetUser, { text: "⚠️ لم أجد القناة المطلوبة." });
                                }
                                continue;
                            }
                        }

                        if (cmd === "الكل") {
                            let details = CHANNELS_CONFIG.map((c, i) => {
                                let limitStr = "";
                                if (c.maxLimit > 0) {
                                    let rem = Math.max(0, c.maxLimit - c.count);
                                    limitStr = ` (الهدف: ${c.maxLimit} | المتبقي: ${rem})`;
                                }
                                let noIgnoreStr = c.noIgnore ? ` | 🛡️ [منع تجاهل]` : "";
                                let reactStr = c.reactMode ? ` | 🔀 [تحويل بالإيموجي]` : "";
                                let emojiCustomStr = c.customEmojis ? ` | 🎨 [إيموجي مخصص]` : "";
                                let suffixStr = c.customSuffix ? ` [${c.customSuffix}]` : "";
                                return `${i + 1}️⃣ *${c.name}*: ${c.count}${limitStr}${noIgnoreStr}${reactStr}${emojiCustomStr}${suffixStr} ${c.paused ? '⏸️' : '🟢'}`;
                            }).join('\n');
                            let totalCount = CHANNELS_CONFIG.reduce((s, c) => s + c.count, 0);
                            await sock.sendMessage(targetUser, { text: `📊 *ملخص القنوات والمراصد*:\n🔥 الإجمالي: ${totalCount}\n\n${details}` });
                            continue;
                        }

                        if (cmd === "الأوامر" || cmd === "الاوامر" || cmd === "مرحبا") {
                            await sock.sendMessage(targetUser, { text: "👋 *الأوامر المتاحة:*\n- المدة (لمعرفة ساعات وأيام العمل الحالية)\n- تصفير المدة (لتصفير عداد الساعات)\n- تغيير ايموجي [اسم القناة]\n- تغيير رقم [اسم القناة]\n- كنسل ايموجي [اسم القناة]\n- تحويل [اسم القناة]\n- إيقاف تحويل [اسم القناة]\n- الكل\n- إضافة\n- حذف\n- ايقاف [اسم القناة]\n- تشغيل [اسم القناة]\n- هدف [اسم القناة] [الرقم]\n- منع تجاهل [اسم القناة]\n- السماح بالتجاهل [اسم القناة]\n- زيادة [اسم القناة] [الرقم]\n- خصم [اسم القناة] [الرقم]\n- تصفير [اسم القناة]\n- انعاش" });
                            continue;
                        }

                        if (cmd === "إضافة" || cmd === "اضافة") {
                            USER_STATE[targetUser] = "WAITING_ADD_LINK";
                            await sock.sendMessage(targetUser, { text: `➕ *إضافة قناة جديدة*\n\nالخطوة 1️⃣: اعمل *رد (Reply)* على هذه الرسالة وأرسل رابط القناة:` });
                            continue;
                        }

                        if (cmd === "حذف") {
                            if (CHANNELS_CONFIG.length === 0) {
                                await sock.sendMessage(targetUser, { text: `⚠️ لا توجد قنوات مسجلة حالياً.` });
                                continue;
                            }
                            USER_STATE[targetUser] = "WAITING_DELETE";
                            let channelList = CHANNELS_CONFIG.map((c, i) => `${i + 1}️⃣ *${c.name}*`).join('\n');
                            await sock.sendMessage(targetUser, { text: `🗑️ *حذف قناة*\n\nرد على هذه الرسالة برقم أو اسم القناة للحذف:\n\n${channelList}` });
                            continue;
                        }

                        if (cmd.startsWith("ايقاف ") || cmd.startsWith("إيقاف ") || cmd.startsWith("وقف ")) {
                            let chName = cmd.replace(/^(ايقاف|إيقاف|وقف)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.paused = true;
                                targetChannel.status = "موقوفة يدوياً";
                                saveChannels(true);
                                await sock.sendMessage(targetUser, { text: `⏸️ *تم إيقاف مؤقت لقناة (${targetChannel.name}) بنجاح!*` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد قناة بهذا الاسم.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("منع تجاهل ") || cmd.startsWith("منع تجاهل رسايل ")) {
                            let chName = cmd.replace(/^(منع تجاهل رسايل|منع تجاهل)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.noIgnore = true;
                                saveChannels(true);
                                await sock.sendMessage(targetUser, { text: `🛡️ *تم تشغيل ميزة منع تجاهل منشورات قناة (${targetChannel.name}) بنجاح!*\n(سيعالج البوت آخر 10 رسائل فائتة كحد أقصى ولن يتجاهلها).` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد القناة المطلوبة.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("السماح بالتجاهل ") || cmd.startsWith("الغاء منع التجاهل ")) {
                            let chName = cmd.replace(/^(السماح بالتجاهل|الغاء منع التجاهل)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.noIgnore = false;
                                saveChannels(true);
                                await sock.sendMessage(targetUser, { text: `✅ *تم إيقاف ميزة منع التجاهل لقناة (${targetChannel.name}) بنجاح (سيتم تجاهل الفائت ورصد الجديد فقط).*` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد القناة المطلوبة.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("تشغيل ") || cmd.startsWith("تفعيل ")) {
                            let chName = cmd.replace(/^(تشغيل|تفعيل)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.paused = false;
                                targetChannel.status = "نشطة";
                                targetChannel._skipOld = !targetChannel.noIgnore;

                                saveChannels(true);
                                let currentCount = targetChannel.count;
                                let ignoreMsg = targetChannel.noIgnore ? "🛡️ (ميزة منع التجاهل مفعلة: معالجة آخر 10 رسائل فائتة كحد أقصى)." : "✨ (سيتم تجاهل المنشورات الفائتة ورصد الجديد فقط).";
                                await sock.sendMessage(targetUser, { text: `🟢 *تم تفعيل وتشغيل قناة (${targetChannel.name}) بنجاح!*\n🔥 العداد الحالي محفوظ: *${currentCount}*\n${ignoreMsg}` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد قناة بهذا الاسم.` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("هدف ") || cmd.startsWith("الهدف ")) {
                            let parts = cmd.replace(/^(هدف|الهدف)\s+/, "").trim().split(/\s+/);
                            let valStr = parts.pop();
                            let chName = parts.join(" ");
                            let limitVal = parseInt(valStr);
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));

                            if (targetChannel && !isNaN(limitVal)) {
                                targetChannel.maxLimit = limitVal;
                                targetChannel.paused = false;
                                targetChannel.status = "نشطة (هدف جديد)";
                                targetChannel._skipOld = !targetChannel.noIgnore;

                                saveChannels(true);
                                let rem = Math.max(0, limitVal - targetChannel.count);
                                let ignoreMsg = targetChannel.noIgnore ? "🛡️ (ميزة منع التجاهل مفعلة: آخر 10 رسائل فائتة)." : "✨ (تم تجاهل الرسائل الفائتة والبدء برصد الجديد).";
                                await sock.sendMessage(targetUser, { text: `🎯 *تم تعيين الهدف الجديد بنجاح!*\n📌 القناة: *${targetChannel.name}*\n🎯 الهدف الجديد: *${limitVal}*\n🔥 العداد الحالي محفوظ: *${targetChannel.count}*\n⏳ المتبقي للهدف: *${rem}*\n${ignoreMsg}` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ خطأ بالتنسيق. استخدم: \`هدف [اسم القناة] [الرقم]\`` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("زيادة ") || cmd.startsWith("اضافه ")) {
                            let parts = cmd.replace(/^(زيادة|اضافه)\s+/, "").trim().split(/\s+/);
                            let valStr = parts.pop();
                            let chName = parts.join(" ");
                            let addVal = parseInt(valStr);
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel && !isNaN(addVal)) {
                                targetChannel.count += addVal;
                                saveChannels(true);
                                let limitText = targetChannel.maxLimit > 0 ? `\n⏳ المتبقي للهدف: *${Math.max(0, targetChannel.maxLimit - targetChannel.count)}*` : "";
                                await sock.sendMessage(targetUser, { text: `📈 *تمت الزيادة!*\n📌 القناة: *${targetChannel.name}*\n🔥 العداد الحالي: *${targetChannel.count}*${limitText}` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ خطأ بالتنسيق. استخدم: \`زيادة [اسم القناة] [الرقم]\`` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("خصم ") || cmd.startsWith("انقاص ")) {
                            let parts = cmd.replace(/^(خصم|انقاص)\s+/, "").trim().split(/\s+/);
                            let valStr = parts.pop();
                            let chName = parts.join(" ");
                            let subVal = parseInt(valStr);
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel && !isNaN(subVal)) {
                                targetChannel.count = Math.max(0, targetChannel.count - subVal);
                                saveChannels(true);
                                let limitText = targetChannel.maxLimit > 0 ? `\n⏳ المتبقي للهدف: *${Math.max(0, targetChannel.maxLimit - targetChannel.count)}*` : "";
                                await sock.sendMessage(targetUser, { text: `📉 *تم الخصم!*\n📌 القناة: *${targetChannel.name}*\n🔥 العداد الحالي: *${targetChannel.count}*${limitText}` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ خطأ بالتنسيق. استخدم: \`خصم [اسم القناة] [الرقم]\`` });
                            }
                            continue;
                        }

                        if (cmd.startsWith("تصفير ") || cmd.startsWith("صفر ")) {
                            let chName = cmd.replace(/^(تصفير|صفر)\s+/, "").trim();
                            let targetChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, chName));
                            if (targetChannel) {
                                targetChannel.count = 0;
                                saveChannels(true);
                                let limitText = targetChannel.maxLimit > 0 ? `\n⏳ المتبقي للهدف: *${targetChannel.maxLimit}*` : "";
                                await sock.sendMessage(targetUser, { text: `🔄 *تم تصفير عداد قناة (${targetChannel.name}) بنجاح!*${limitText}` });
                            } else {
                                await sock.sendMessage(targetUser, { text: `⚠️ لم أجد القناة.` });
                            }
                            continue;
                        }

                        if (cmd === "إنعاش" || cmd === "انعاش" || cmd === "تحديث") {
                            loadChannels();
                            cleanSessionJunk();
                            await sock.sendMessage(targetUser, { text: "⚡ *تم تحديث البيانات وتنظيف المخلفات وإنعاش البوت بنجاح! إليك النسخ الاحتياطية:* " });

                            if (fs.existsSync(CHANNELS_FILE)) {
                                await sock.sendMessage(targetUser, {
                                    document: fs.readFileSync(CHANNELS_FILE),
                                    mimetype: 'application/json',
                                    fileName: 'channels.json',
                                    caption: '📊 ملف الإحصائيات (channels.json)'
                                });
                            }

                            if (fs.existsSync('./index.js')) {
                                await sock.sendMessage(targetUser, {
                                    document: fs.readFileSync('./index.js'),
                                    mimetype: 'text/javascript',
                                    fileName: 'index.js',
                                    caption: '🤖 ملف البوت الرئيسي (index.js)'
                                });
                            }
                            continue;
                        }

                        let viewChannel = CHANNELS_CONFIG.find(c => nameMatches(c.name, cmd));
                        if (viewChannel) {
                            let lastTimeStr = viewChannel.lastPostTime ? viewChannel.lastPostTime : 'لم يتم النشر بعد';
                            let statusStr = viewChannel.paused ? '⏸️ موقوفة' : '🟢 تعمل';
                            let channelLink = `https://whatsapp.com/channel/${viewChannel.code}`;
                            let creationDay = viewChannel.startDay || "غير متوفر";
                            let noIgnoreStatus = viewChannel.noIgnore ? "مفعلة (آخر 10 رسائل فائتة كحد أقصى)" : "غير مفعلة";
                            let reactModeStatus = viewChannel.reactMode ? "مفعل (مع إيموجيات التفاعل)" : "طبيعي (بدون إيموجي)";
                            let customEmojiStatus = viewChannel.customEmojis ? "مخصص (موجود)" : "الافتراضي";
                            let suffixStatus = viewChannel.customSuffix ? ` (${viewChannel.customSuffix})` : "بدون";

                            let limitDesc = "مفتوح (بدون هدف)";
                            if (viewChannel.maxLimit > 0) {
                                let rem = Math.max(0, viewChannel.maxLimit - viewChannel.count);
                                limitDesc = `${viewChannel.maxLimit} (المتبقي للهدف: ${rem} منشور)`;
                            }

                            let replyText = `📊 قناة *${viewChannel.name}*\n📅 وقت الإنشاء: ${creationDay}\n🔗 الرابط: ${channelLink}\n🔥 المرصود الحقيقي: ${viewChannel.count}\n🎯 الهدف: ${limitDesc}\n🛡️ منع التجاهل: ${noIgnoreStatus}\n🔀 وضع التحويل: ${reactModeStatus}\n🎨 الإيموجيات: ${customEmojiStatus}\n📌 الرمز اللاحق: ${suffixStatus}\n🕒 آخر منشور: ${lastTimeStr}\n📌 الحالة: ${statusStr}`;
                            await sock.sendMessage(targetUser, { text: replyText });
                            continue;
                        }
                    }
                } catch (e) {
                    console.log("❌ خطأ داخل حلقة معالجة الرسائل الخاصة:", e);
                }
            }
        });
    } finally {
        setTimeout(() => {
            isStarting = false;
        }, 2000);
    }
}

app.get('/', (req, res) => res.send("BOT ONLINE"));
app.listen(process.env.PORT || 3000, () => console.log(`Server Ready`));
startBot();
