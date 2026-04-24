const cfg = {
  locale: 'ja-JP',

  // 毎日の予定一覧通知時刻
  main: '07:00',

  // 何分前に通知するか
  trg: 30,

  // 30分前通知の確認間隔
  // Apps Scriptのトリガー上限対策として、予定ごとにトリガーを作らず5分ごとに確認します
  reminderCheckMinutes: 5,

  webhooks: [
    'https://discord.com/api/webhooks/ 置き換えてね'
  ],

  opt: {
    maxResults: 2500,
    showDeleted: true
  },

  col: [
    null,
    '#a4bdfc',
    '#7AE7BF',
    '#BDADFF',
    '#FF887C',
    '#FBD75B',
    '#FFB878',
    '#46D6DB',
    '#E1E1E1',
    '#5484ED',
    '#51B749',
    '#DC2127'
  ],

  mention: '<@&1384207112925745162>',
  botName: 'Google Calendar',
  avatar: 'https://cdn.krnk.org/kuronekoserver/logo-white.png'
};

const prop = PropertiesService.getScriptProperties();

function getCalendars_() {
  // 自分が所有しているカレンダーのみ対象
  return CalendarApp.getAllOwnedCalendars();
  // 共有カレンダーも含めたい場合は以下に変更してください
  //return CalendarApp.getAllCalendars();
}

function safeText_(v) {
  return v == null ? '' : String(v);
}

function truncate_(s, maxLen) {
  s = safeText_(s);
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

function fmtDate_(d, allDay) {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(
    d,
    tz,
    allDay ? 'yyyy/MM/dd' : 'yyyy/MM/dd HH:mm'
  );
}

function fmtKeyDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyyMMdd');
}

function parseHHMM_(hhmm) {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    throw new Error(`cfg.main の形式が不正です: ${hhmm}`);
  }

  const h = Number(m[1]);
  const min = Number(m[2]);

  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new Error(`cfg.main の時刻が不正です: ${hhmm}`);
  }

  return { h, m: min };
}

function normalizeHexColor_(color, fallback) {
  const ok = x => typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x);

  if (ok(color)) return color;
  if (ok(fallback)) return fallback;

  return '#87cefa';
}

function hexToDecimalColor_(hex) {
  const color = normalizeHexColor_(hex, '#87cefa');
  return parseInt(color.slice(1), 16);
}

function splitIntoChunks_(arr, size) {
  const out = [];

  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }

  return out;
}

function sendToDiscord_(payload) {
  const body = JSON.stringify({
    username: cfg.botName,
    avatar_url: cfg.avatar,
    allowed_mentions: {
      parse: ['roles', 'users']
    },
    ...payload
  });

  for (const url of cfg.webhooks) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();

    if (code < 200 || code >= 300) {
      throw new Error(`Discord webhook failed: ${code} ${res.getContentText()}`);
    }

    Utilities.sleep(1000);
  }
}

function sendEmbedChunks_(basePayload, embeds) {
  if (!embeds || embeds.length === 0) return;

  const chunks = splitIntoChunks_(embeds, 10);

  chunks.forEach((chunk, i) => {
    sendToDiscord_({
      ...basePayload,
      content: i === 0 ? basePayload.content : '',
      embeds: chunk
    });
  });
}

function formatCalendarEvent_(ev, cal) {
  const allDay = ev.isAllDayEvent();

  const start = allDay
    ? ev.getAllDayStartDate()
    : ev.getStartTime();

  const end = allDay
    ? new Date(ev.getAllDayEndDate().getTime() - 1)
    : ev.getEndTime();

  const evColor = ev.getColor ? ev.getColor() : null;
  const calColor = cal && cal.getColor ? cal.getColor() : null;
  const color = normalizeHexColor_(evColor, calColor);

  const when = allDay
    ? `${fmtDate_(start, true)} 〜 ${fmtDate_(end, true)}`
    : `${fmtDate_(start, false)} 〜 ${fmtDate_(end, false)}`;

  const desc = safeText_(ev.getDescription ? ev.getDescription() : '');

  return {
    color: hexToDecimalColor_(color),
    title: truncate_(ev.getTitle ? ev.getTitle() : '(無題)', 256),
    description: truncate_((desc ? desc + '\n\n' : '') + when, 4096),
    footer: {
      text: cal ? cal.getName() : ''
    }
  };
}

function formatApiEvent_(item, calName) {
  const allDay = !!(item.start && item.start.date);
  const title = truncate_(item.summary || '(無題)', 256);

  let when = '';

  if (allDay) {
    const s = new Date(item.start.date);
    const e = item.end && item.end.date
      ? new Date(new Date(item.end.date).getTime() - 1)
      : s;

    when = `${fmtDate_(s, true)} 〜 ${fmtDate_(e, true)}`;
  } else {
    const s = item.start && item.start.dateTime
      ? new Date(item.start.dateTime)
      : new Date();

    const e = item.end && item.end.dateTime
      ? new Date(item.end.dateTime)
      : s;

    when = `${fmtDate_(s, false)} 〜 ${fmtDate_(e, false)}`;
  }

  const desc = safeText_(item.description || '');

  let color = '#87cefa';

  if (item.colorId && cfg.col[Number(item.colorId)]) {
    color = cfg.col[Number(item.colorId)];
  }

  return {
    color: hexToDecimalColor_(color),
    title,
    description: truncate_((desc ? desc + '\n\n' : '') + when, 4096),
    footer: {
      text: calName || 'Google Calendar'
    }
  };
}

function todayEvents_() {
  const now = new Date();
  const cals = getCalendars_();

  return cals.flatMap(cal =>
    cal.getEventsForDay(now).map(ev => ({ ev, cal }))
  );
}

function main() {
  const events = todayEvents_();
  const embeds = events.map(x => formatCalendarEvent_(x.ev, x.cal));

  if (embeds.length === 0) {
    sendToDiscord_({
      content: `今日のイベントはありません ${cfg.mention}`
    });
    return;
  }

  sendEmbedChunks_({
    content: `今日のイベント ${cfg.mention}`
  }, embeds);
}

function getReminderMap_() {
  const key = `reminded_${fmtKeyDate_(new Date())}`;
  const raw = prop.getProperty(key);

  if (!raw) return { key, map: {} };

  try {
    return { key, map: JSON.parse(raw) };
  } catch (e) {
    return { key, map: {} };
  }
}

function saveReminderMap_(key, map) {
  prop.setProperty(key, JSON.stringify(map));
}

function cleanupOldReminderMaps_() {
  const todayKey = `reminded_${fmtKeyDate_(new Date())}`;
  const all = prop.getProperties();

  Object.keys(all).forEach(key => {
    if (key.startsWith('reminded_') && key !== todayKey) {
      prop.deleteProperty(key);
    }
  });
}

function checkReminders() {
  const now = new Date();
  const until = new Date(now.getTime() + cfg.trg * 60 * 1000);
  const cals = getCalendars_();

  const state = getReminderMap_();
  const sent = state.map;

  const embeds = [];
  const titles = [];

  cals.forEach(cal => {
    const events = cal.getEvents(now, until);

    events.forEach(ev => {
      if (ev.isAllDayEvent()) return;

      const start = ev.getStartTime();
      const diff = start.getTime() - now.getTime();

      if (diff <= 0) return;
      if (diff > cfg.trg * 60 * 1000) return;

      const uniqueKey = [
        cal.getId(),
        ev.getId(),
        start.getTime()
      ].join('|');

      if (sent[uniqueKey]) return;

      sent[uniqueKey] = new Date().toISOString();

      titles.push(ev.getTitle());
      embeds.push(formatCalendarEvent_(ev, cal));
    });
  });

  saveReminderMap_(state.key, sent);

  if (embeds.length === 0) return;

  sendEmbedChunks_({
    content: `開始${cfg.trg}分前のイベントがあります ${cfg.mention}`
  }, embeds);
}

function readSyncAllPages_(calendarId, options) {
  let pageToken = null;
  let last = null;
  const items = [];

  do {
    const opt = { ...options };

    if (pageToken) {
      opt.pageToken = pageToken;
    }

    last = GoogleCalendarAPI.Events.list(calendarId, opt);

    if (last.items && last.items.length) {
      items.push(...last.items);
    }

    pageToken = last.nextPageToken || null;
  } while (pageToken);

  return {
    items,
    nextSyncToken: last ? last.nextSyncToken : null
  };
}

function storeSyncToken_(calendarId, fullSync) {
  const tokenKey = `syncToken_${calendarId}`;
  const token = prop.getProperty(tokenKey);

  const options = {
    ...cfg.opt
  };

  if (!fullSync && token) {
    options.syncToken = token;
  }

  const result = readSyncAllPages_(calendarId, options);

  if (!result.nextSyncToken) {
    throw new Error(`nextSyncToken を取得できませんでした: ${calendarId}`);
  }

  prop.setProperty(tokenKey, result.nextSyncToken);

  return result.items;
}

function sync_init() {
  const cals = getCalendars_();

  cals.forEach(cal => {
    storeSyncToken_(cal.getId(), true);
  });
}

function sync(e) {
  const calendarId = e && e.calendarId;

  if (!calendarId) {
    throw new Error('calendarId がありません。カレンダー更新トリガーから実行してください。');
  }

  const tokenKey = `syncToken_${calendarId}`;
  const token = prop.getProperty(tokenKey);

  const cal = getCalendars_().find(c => c.getId() === calendarId);
  const calName = cal ? cal.getName() : calendarId;

  if (!token) {
    storeSyncToken_(calendarId, true);
    return;
  }

  let items;

  try {
    items = storeSyncToken_(calendarId, false);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);

    if (
      msg.includes('Sync token is no longer valid') ||
      msg.includes('410') ||
      msg.includes('Gone')
    ) {
      storeSyncToken_(calendarId, true);

      sendToDiscord_({
        content: `カレンダー同期トークンを再作成しました: ${calName}`
      });

      return;
    }

    throw err;
  }

  if (!items || items.length === 0) return;

  const embeds = items.map(item => {
    if (item.status === 'cancelled') {
      return {
        title: truncate_(item.summary || '削除されたイベント', 256),
        description: 'このイベントは削除されました。',
        color: 0x87cefa,
        fields: [
          {
            name: '操作',
            value: '削除',
            inline: false
          }
        ],
        footer: {
          text: calName
        }
      };
    }

    const created = item.created ? Date.parse(item.created) : 0;
    const updated = item.updated ? Date.parse(item.updated) : 0;

    const op = created && updated && Math.abs(updated - created) < 10000
      ? '追加'
      : '変更';

    const base = formatApiEvent_(item, calName);

    return {
      ...base,
      fields: [
        {
          name: '操作',
          value: op,
          inline: false
        }
      ]
    };
  });

  sendEmbedChunks_({
    content: `カレンダーに変更がありました ${cfg.mention}`
  }, embeds);
}

function daily() {
  cleanupOldReminderMaps_();

  // main の一回限りトリガーだけ作り直す
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'main') {
      ScriptApp.deleteTrigger(t);
    }
  });

  const now = new Date();
  const { h, m } = parseHHMM_(cfg.main);

  const mainAt = new Date(now);
  mainAt.setHours(h, m, 0, 0);

  if (mainAt.getTime() > now.getTime()) {
    ScriptApp.newTrigger('main')
      .timeBased()
      .at(mainAt)
      .create();
  }
}

function deleteManagedTriggers_() {
  const names = new Set([
    'main',
    'daily',
    'sync',
    'checkReminders'
  ]);

  ScriptApp.getProjectTriggers().forEach(t => {
    if (names.has(t.getHandlerFunction())) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function setup() {
  deleteManagedTriggers_();

  // 差分取得用の初期同期
  // 初回は通知を飛ばさず、現在の状態を保存する
  sync_init();

  const cals = getCalendars_();

  // 追加・変更・削除検知用トリガー
  cals.forEach(cal => {
    ScriptApp.newTrigger('sync')
      .forUserCalendar(cal.getId())
      .onEventUpdated()
      .create();
  });

  // 毎日0時台に、その日の通知設定を作り直す
  ScriptApp.newTrigger('daily')
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .create();

  // 30分前通知確認
  ScriptApp.newTrigger('checkReminders')
    .timeBased()
    .everyMinutes(cfg.reminderCheckMinutes)
    .create();

  // 今日分の main 通知を作成
  daily();

  sendToDiscord_({
    content: `Googleカレンダー通知のセットアップが完了しました ${cfg.mention}`
  });
}

function reset() {
  deleteManagedTriggers_();

  const all = prop.getProperties();

  Object.keys(all).forEach(key => {
    if (
      key.startsWith('syncToken_') ||
      key.startsWith('reminded_')
    ) {
      prop.deleteProperty(key);
    }
  });

  sendToDiscord_({
    content: `Googleカレンダー通知の設定をリセットしました ${cfg.mention}`
  });
}
